use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, MSG, MSLLHOOKSTRUCT,
    PM_NOREMOVE, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
};

const MAX_PENDING_CLICKS: usize = 512;
pub const CLICK_ANIMATION_DURATION_MS: u64 = 520;
const CLICK_ANIMATION_DURATION: Duration = Duration::from_millis(CLICK_ANIMATION_DURATION_MS);

#[derive(Clone, Copy, Debug)]
enum ClickButton {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug)]
struct ClickEvent {
    screen_x: i32,
    screen_y: i32,
    button: ClickButton,
    at: Instant,
}

#[derive(Clone, Copy, Debug)]
pub struct ClickMarker {
    pub x: i32,
    pub y: i32,
    pub age_ms: u64,
    button: ClickButton,
}

type ClickQueue = Arc<Mutex<VecDeque<ClickEvent>>>;

// Only one recording session can be active, so the hook can use one process-
// wide queue without passing raw pointers through the Windows callback ABI.
static ACTIVE_CLICK_QUEUE: OnceLock<Mutex<Option<ClickQueue>>> = OnceLock::new();

fn active_click_queue() -> &'static Mutex<Option<ClickQueue>> {
    ACTIVE_CLICK_QUEUE.get_or_init(|| Mutex::new(None))
}

fn clear_active_click_queue(queue: &ClickQueue) {
    if let Ok(mut active) = active_click_queue().lock() {
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, queue))
        {
            *active = None;
        }
    }
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let button = match wparam.0 as u32 {
            WM_LBUTTONDOWN => Some(ClickButton::Left),
            WM_RBUTTONDOWN => Some(ClickButton::Right),
            WM_MBUTTONDOWN => Some(ClickButton::Middle),
            _ => None,
        };

        if let Some(button) = button {
            let hook_data = lparam.0 as *const MSLLHOOKSTRUCT;
            if !hook_data.is_null() {
                // The low-level hook callback must stay lightweight. It only
                // copies the native point into a bounded queue; frame drawing
                // happens on the recording worker.
                if let Some(queue) = active_click_queue()
                    .lock()
                    .ok()
                    .and_then(|active| active.clone())
                {
                    let point = unsafe { &*hook_data };
                    if let Ok(mut pending) = queue.lock() {
                        if pending.len() >= MAX_PENDING_CLICKS {
                            pending.pop_front();
                        }
                        pending.push_back(ClickEvent {
                            screen_x: point.pt.x,
                            screen_y: point.pt.y,
                            button,
                            at: Instant::now(),
                        });
                    }
                }
            }
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

pub struct ClickTracker {
    queue: ClickQueue,
    active: Vec<ClickEvent>,
    stop: Arc<AtomicBool>,
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl ClickTracker {
    pub fn start() -> Result<Self, String> {
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        {
            let mut active = active_click_queue()
                .lock()
                .map_err(|_| "鼠标点击监听锁损坏".to_string())?;
            if active.is_some() {
                return Err("已有鼠标点击监听正在运行".to_string());
            }
            *active = Some(queue.clone());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let thread_id = Arc::new(AtomicU32::new(0));
        let (ready_tx, ready_rx) = sync_channel(1);
        let thread_stop = Arc::clone(&stop);
        let thread_id_slot = Arc::clone(&thread_id);
        let hook_thread = match thread::Builder::new()
            .name("pin-shot-mouse-hook".to_string())
            .spawn(move || unsafe {
                let native_thread_id = GetCurrentThreadId();
                thread_id_slot.store(native_thread_id, Ordering::Release);

                // Creating the message queue before installing the hook makes
                // PostThreadMessageW reliable during shutdown.
                let mut message = MSG::default();
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);

                let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) {
                    Ok(hook) => hook,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("安装鼠标点击监听失败: {error}")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(native_thread_id));

                while !thread_stop.load(Ordering::Acquire) {
                    let result = GetMessageW(&mut message, None, 0, 0);
                    if result.0 <= 0 {
                        break;
                    }
                    let _ = TranslateMessage(&message);
                    let _ = DispatchMessageW(&message);
                }

                let _ = UnhookWindowsHookEx(hook);
            }) {
            Ok(thread) => thread,
            Err(error) => {
                clear_active_click_queue(&queue);
                return Err(format!("创建鼠标点击监听线程失败: {error}"));
            }
        };

        match ready_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(native_thread_id)) => Ok(Self {
                queue,
                active: Vec::new(),
                stop,
                thread_id: native_thread_id,
                thread: Some(hook_thread),
            }),
            Ok(Err(error)) => {
                stop.store(true, Ordering::Release);
                let _ = hook_thread.join();
                clear_active_click_queue(&queue);
                Err(error)
            }
            Err(error) => {
                stop.store(true, Ordering::Release);
                let native_thread_id = thread_id.load(Ordering::Acquire);
                if native_thread_id != 0 {
                    unsafe {
                        let _ = PostThreadMessageW(native_thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
                    }
                }
                let _ = hook_thread.join();
                clear_active_click_queue(&queue);
                Err(format!("等待鼠标点击监听启动失败: {error}"))
            }
        }
    }

    pub fn snapshot(
        &mut self,
        now: Instant,
        screen_x: i32,
        screen_y: i32,
        width: i32,
        height: i32,
    ) -> Vec<ClickMarker> {
        if let Ok(mut pending) = self.queue.lock() {
            self.active.extend(pending.drain(..));
        }

        self.active
            .retain(|event| now.saturating_duration_since(event.at) <= CLICK_ANIMATION_DURATION);

        self.active
            .iter()
            .filter_map(|event| {
                let x = event.screen_x - screen_x;
                let y = event.screen_y - screen_y;
                if x < 0 || y < 0 || x >= width || y >= height {
                    return None;
                }
                Some(ClickMarker {
                    x,
                    y,
                    age_ms: now.saturating_duration_since(event.at).as_millis() as u64,
                    button: event.button,
                })
            })
            .collect()
    }
}

impl Drop for ClickTracker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if self.thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        clear_active_click_queue(&self.queue);
    }
}

pub fn draw_click_indicators(pixels: &mut [u8], width: u32, height: u32, markers: &[ClickMarker]) {
    if width == 0 || height == 0 || pixels.len() < (width as usize) * (height as usize) * 4 {
        return;
    }

    for marker in markers {
        let progress = (marker.age_ms as f32 / CLICK_ANIMATION_DURATION_MS as f32).clamp(0.0, 1.0);
        let eased = 1.0 - (1.0 - progress).powi(2);
        let radius = 10.0 + eased * 28.0;
        let alpha = (1.0 - progress).powf(1.2) * 0.58;
        let color = match marker.button {
            ClickButton::Left => [37, 99, 235],
            ClickButton::Right => [234, 88, 12],
            ClickButton::Middle => [147, 51, 234],
        };

        // A bright outer edge keeps the ripple visible on both light and
        // dark application backgrounds; the colored inner edge identifies
        // the click without obscuring the underlying content.
        draw_ring(
            pixels,
            width,
            height,
            marker.x as f32,
            marker.y as f32,
            radius,
            4.0,
            [255, 255, 255],
            alpha * 0.72,
        );
        draw_ring(
            pixels,
            width,
            height,
            marker.x as f32,
            marker.y as f32,
            radius,
            2.5,
            color,
            alpha,
        );

        let dot_alpha = (1.0 - progress).powf(0.45) * 0.68;
        draw_filled_circle(
            pixels,
            width,
            height,
            marker.x as f32,
            marker.y as f32,
            4.0,
            color,
            dot_alpha,
        );
        draw_filled_circle(
            pixels,
            width,
            height,
            marker.x as f32,
            marker.y as f32,
            1.5,
            [255, 255, 255],
            dot_alpha,
        );
    }
}

fn draw_ring(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    center_x: f32,
    center_y: f32,
    radius: f32,
    thickness: f32,
    color: [u8; 3],
    alpha: f32,
) {
    let padding = thickness * 0.5 + 1.0;
    let left = (center_x - radius - padding).floor() as i32;
    let right = (center_x + radius + padding).ceil() as i32;
    let top = (center_y - radius - padding).floor() as i32;
    let bottom = (center_y + radius + padding).ceil() as i32;
    let half_thickness = thickness * 0.5 + 0.75;

    for y in top.max(0)..=bottom.min(height as i32 - 1) {
        for x in left.max(0)..=right.min(width as i32 - 1) {
            let dx = x as f32 - center_x;
            let dy = y as f32 - center_y;
            let distance = (dx * dx + dy * dy).sqrt();
            let coverage = (1.0 - (distance - radius).abs() / half_thickness).clamp(0.0, 1.0);
            blend_pixel(pixels, width, x, y, color, alpha * coverage);
        }
    }
}

fn draw_filled_circle(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    center_x: f32,
    center_y: f32,
    radius: f32,
    color: [u8; 3],
    alpha: f32,
) {
    let left = (center_x - radius - 1.0).floor() as i32;
    let right = (center_x + radius + 1.0).ceil() as i32;
    let top = (center_y - radius - 1.0).floor() as i32;
    let bottom = (center_y + radius + 1.0).ceil() as i32;

    for y in top.max(0)..=bottom.min(height as i32 - 1) {
        for x in left.max(0)..=right.min(width as i32 - 1) {
            let dx = x as f32 - center_x;
            let dy = y as f32 - center_y;
            let distance = (dx * dx + dy * dy).sqrt();
            let coverage = (radius + 0.75 - distance).clamp(0.0, 1.0);
            blend_pixel(pixels, width, x, y, color, alpha * coverage);
        }
    }
}

fn blend_pixel(pixels: &mut [u8], width: u32, x: i32, y: i32, color: [u8; 3], alpha: f32) {
    if alpha <= 0.0 || x < 0 || y < 0 {
        return;
    }
    let index = ((y as usize) * (width as usize) + x as usize) * 4;
    if index + 3 >= pixels.len() {
        return;
    }
    let source_alpha = alpha.clamp(0.0, 1.0);
    let destination_alpha = 1.0 - source_alpha;
    for channel in 0..3 {
        pixels[index + channel] = (color[channel] as f32 * source_alpha
            + pixels[index + channel] as f32 * destination_alpha)
            .round() as u8;
    }
    pixels[index + 3] = 0xff;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_indicator_renders_and_fades() {
        let mut pixels = vec![0; 64 * 64 * 4];
        let marker = ClickMarker {
            x: 32,
            y: 32,
            age_ms: 0,
            button: ClickButton::Left,
        };
        draw_click_indicators(&mut pixels, 64, 64, &[marker]);
        assert!(pixels
            .chunks_exact(4)
            .any(|pixel| pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0));

        let mut faded = vec![0; 64 * 64 * 4];
        draw_click_indicators(
            &mut faded,
            64,
            64,
            &[ClickMarker {
                age_ms: CLICK_ANIMATION_DURATION_MS,
                ..marker
            }],
        );
        assert!(faded.iter().all(|channel| *channel == 0));
    }
}
