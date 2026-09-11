use crate::click_indicator::{draw_click_indicators, ClickMarker, ClickTracker};
use crate::diagnostics;
use image::codecs::gif::{GifEncoder, Repeat};
use image::{imageops, Delay, Frame, RgbaImage};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};

pub const STATE_RECORDING: u8 = 1;
pub const STATE_PAUSED: u8 = 2;
pub const STATE_STOPPED: u8 = 3;

// Frames are kept as uncompressed RGBA so they can be previewed and exported
// without loss. Store the bytes in a temporary file; keeping every frame in
// the Rust heap makes a long, high-resolution recording consume gigabytes.
const MAX_RECORDING_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 512 * 1024 * 1024;
// Keep the in-memory timestamp/offset index bounded even for a tiny capture
// region where the disk limit would otherwise allow billions of entries.
const MAX_RECORDING_INDEX_ENTRIES: usize = 100_000;
const MAX_PREVIEW_FRAMES: usize = 120;
const MAX_PREVIEW_BYTES: usize = 64 * 1024 * 1024;
static NEXT_CACHE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct RecordedFrame {
    pub timestamp_ms: u64,
    pub pixels: Vec<u8>,
    disk_offset: Option<u64>,
}

struct FrameCache {
    path: PathBuf,
    file: Mutex<Option<File>>,
    frame_size: usize,
}

impl FrameCache {
    fn create(frame_size: usize) -> Result<Arc<Self>, String> {
        let temp_dir = std::env::temp_dir();
        for _ in 0..8 {
            let id = NEXT_CACHE_ID.fetch_add(1, Ordering::Relaxed);
            let path = temp_dir.join(format!(
                "pin-shot-recording-{}-{id}.rgba",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .read(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    return Ok(Arc::new(Self {
                        path,
                        file: Mutex::new(Some(file)),
                        frame_size,
                    }));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("创建录制缓存失败: {error}")),
            }
        }
        Err("创建录制缓存失败：临时文件名冲突".to_string())
    }

    fn append(&self, pixels: &[u8]) -> Result<u64, String> {
        if pixels.len() != self.frame_size {
            return Err("录制帧尺寸不匹配".to_string());
        }
        let mut file_guard = self.file.lock().map_err(|_| "录制缓存锁损坏".to_string())?;
        let file = file_guard
            .as_mut()
            .ok_or_else(|| "录制缓存已关闭".to_string())?;
        let offset = file
            .seek(SeekFrom::End(0))
            .map_err(|error| format!("定位录制缓存失败: {error}"))?;
        file.write_all(pixels)
            .map_err(|error| format!("写入录制缓存失败: {error}"))?;
        Ok(offset)
    }

    fn read_frame(&self, offset: u64) -> Result<Vec<u8>, String> {
        let mut file_guard = self.file.lock().map_err(|_| "录制缓存锁损坏".to_string())?;
        let file = file_guard
            .as_mut()
            .ok_or_else(|| "录制缓存已关闭".to_string())?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("读取录制缓存失败: {error}"))?;
        let mut pixels = vec![0u8; self.frame_size];
        file.read_exact(&mut pixels)
            .map_err(|error| format!("读取录制帧失败: {error}"))?;
        Ok(pixels)
    }
}

impl Drop for FrameCache {
    fn drop(&mut self) {
        match self.file.get_mut() {
            Ok(file) => {
                file.take();
            }
            Err(poisoned) => {
                poisoned.into_inner().take();
            }
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFramesResult {
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    #[serde(skip)]
    pub pixels: Vec<u8>,
}

pub struct ActiveRecordingSession {
    pub screen_x: i32,
    pub screen_y: i32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Native overlay handle captured while the Tauri event loop is healthy.
    /// Fetching it again during stop performs a synchronous event-loop round
    /// trip and can wait forever when the WebView is transitioning state.
    pub overlay_hwnd: isize,
    pub state: Arc<AtomicU8>,
    pub capacity_reached: Arc<AtomicBool>,
    frames: Arc<Mutex<Vec<RecordedFrame>>>,
    cache: Option<Arc<FrameCache>>,
    preview_cache: Arc<Mutex<Option<(u32, PreviewFramesResult)>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub state: String,
    pub frame_count: u32,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub capacity_reached: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportOptions {
    pub speed: Option<f32>,
    pub quality: Option<i32>,
    pub scale: Option<f32>,
    pub target_fps: Option<u32>,
}

pub fn capture_frame_with_cursor(
    screen_x: i32,
    screen_y: i32,
    width: i32,
    height: i32,
    draw_cursor: bool,
    click_markers: &[ClickMarker],
) -> windows::core::Result<Vec<u8>> {
    if width <= 0 || height <= 0 {
        return Err(windows::core::Error::from_win32());
    }
    let pixel_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(windows::core::Error::from_win32)?;

    unsafe {
        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        let old_bitmap = SelectObject(mem_dc, bitmap.into());

        let _ = BitBlt(
            mem_dc,
            0,
            0,
            width,
            height,
            Some(screen_dc),
            screen_x,
            screen_y,
            SRCCOPY,
        );

        if draw_cursor {
            use windows::Win32::UI::WindowsAndMessaging::{
                DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL,
                ICONINFO,
            };
            let mut cursor_info = CURSORINFO {
                cbSize: std::mem::size_of::<CURSORINFO>() as u32,
                flags: Default::default(),
                hCursor: Default::default(),
                ptScreenPos: Default::default(),
            };
            if GetCursorInfo(&mut cursor_info).is_ok() && cursor_info.flags == CURSOR_SHOWING {
                let mut icon_info = ICONINFO::default();
                if GetIconInfo(cursor_info.hCursor.into(), &mut icon_info).is_ok() {
                    let cursor_x = cursor_info.ptScreenPos.x - screen_x - icon_info.xHotspot as i32;
                    let cursor_y = cursor_info.ptScreenPos.y - screen_y - icon_info.yHotspot as i32;
                    if cursor_x > -64
                        && cursor_x < width + 64
                        && cursor_y > -64
                        && cursor_y < height + 64
                    {
                        let _ = DrawIconEx(
                            mem_dc,
                            cursor_x,
                            cursor_y,
                            cursor_info.hCursor.into(),
                            0,
                            0,
                            0,
                            None,
                            DI_NORMAL,
                        );
                    }
                    let _ = DeleteObject(icon_info.hbmMask.into());
                    if !icon_info.hbmColor.is_invalid() {
                        let _ = DeleteObject(icon_info.hbmColor.into());
                    }
                }
            }
        }

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut pixels = vec![0u8; pixel_bytes];
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(mem_dc, old_bitmap);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            // GDI's BI_RGB 32-bit DIB does not define the alpha byte.  Canvas
            // and GIF consumers expect straight, opaque RGBA pixels.
            pixel[3] = 0xff;
        }

        draw_click_indicators(&mut pixels, width as u32, height as u32, click_markers);

        Ok(pixels)
    }
}

impl ActiveRecordingSession {
    pub fn start(
        screen_x: i32,
        screen_y: i32,
        width: u32,
        height: u32,
        fps: u32,
        record_cursor: bool,
        overlay_hwnd: isize,
    ) -> Result<Self, String> {
        let fps = fps.clamp(5, 60);
        let frame_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "录制区域尺寸过大".to_string())?;
        if frame_bytes == 0
            || frame_bytes > MAX_FRAME_BYTES
            || (frame_bytes as u64) > MAX_RECORDING_BYTES
        {
            return Err("录制区域尺寸过大，无法安全缓存原始画面".to_string());
        }
        diagnostics::log(
            "INFO",
            "recorder",
            format!(
                "session start; origin=({},{}); size={}x{}; fps={}; frameBytes={}; cursor={}",
                screen_x, screen_y, width, height, fps, frame_bytes, record_cursor
            ),
        );
        let max_disk_frames = (MAX_RECORDING_BYTES / frame_bytes as u64)
            .max(1)
            .min(usize::MAX as u64) as usize;
        let max_frames = MAX_RECORDING_INDEX_ENTRIES.min(max_disk_frames);
        let state = Arc::new(AtomicU8::new(STATE_RECORDING));
        let capacity_reached = Arc::new(AtomicBool::new(false));
        let frames = Arc::new(Mutex::new(Vec::new()));
        let cache = FrameCache::create(frame_bytes)?;
        let preview_cache = Arc::new(Mutex::new(None));
        let mut click_tracker = match ClickTracker::start() {
            Ok(tracker) => {
                diagnostics::log("INFO", "recorder.click", "click indicator hook started");
                Some(tracker)
            }
            Err(error) => {
                diagnostics::log(
                    "WARN",
                    "recorder.click",
                    format!("click indicator unavailable; error={error}"),
                );
                None
            }
        };

        // Capture initial frame immediately so we always have at least 1 frame
        let initial_clicks = click_tracker
            .as_mut()
            .map(|tracker| {
                tracker.snapshot(
                    Instant::now(),
                    screen_x,
                    screen_y,
                    width as i32,
                    height as i32,
                )
            })
            .unwrap_or_default();
        if let Ok(pixels) = capture_frame_with_cursor(
            screen_x,
            screen_y,
            width as i32,
            height as i32,
            record_cursor,
            &initial_clicks,
        ) {
            let offset = cache.append(&pixels)?;
            frames
                .lock()
                .map_err(|_| "录制帧索引锁损坏".to_string())?
                .push(RecordedFrame {
                    timestamp_ms: 0,
                    pixels: Vec::new(),
                    disk_offset: Some(offset),
                });
        } else {
            diagnostics::log("WARN", "recorder", "initial frame capture failed");
        }

        let state_clone = Arc::clone(&state);
        let capacity_reached_clone = Arc::clone(&capacity_reached);
        let frames_clone = Arc::clone(&frames);
        let cache_clone = Arc::clone(&cache);

        let worker = std::thread::spawn(move || {
            let mut click_tracker = click_tracker;
            diagnostics::log("INFO", "recorder.worker", "capture worker started");
            let interval = Duration::from_micros((1_000_000.0 / fps as f64) as u64);
            let mut next_tick = Instant::now() + interval;
            let mut paused_duration = Duration::ZERO;
            let mut pause_start: Option<Instant> = None;
            let start_instant = Instant::now();
            let mut capture_errors = 0u32;
            let mut capacity_logged = false;

            while state_clone.load(Ordering::Relaxed) != STATE_STOPPED {
                let current_state = state_clone.load(Ordering::Relaxed);
                if current_state == STATE_PAUSED {
                    if pause_start.is_none() {
                        pause_start = Some(Instant::now());
                    }
                    std::thread::sleep(Duration::from_millis(30));
                    continue;
                }
                if let Some(p_start) = pause_start.take() {
                    paused_duration += p_start.elapsed();
                    next_tick = Instant::now() + interval;
                }

                // Check before performing an expensive GDI capture. Once the
                // disk cache limit is reached, remain paused until the user
                // stops or cancels the recording.
                if frames_clone
                    .lock()
                    .is_ok_and(|frames| frames.len() >= max_frames)
                {
                    capacity_reached_clone.store(true, Ordering::Relaxed);
                    state_clone.store(STATE_PAUSED, Ordering::Relaxed);
                    if !capacity_logged {
                        diagnostics::log(
                            "WARN",
                            "recorder.worker",
                            format!("recording capacity reached; frames={max_frames}"),
                        );
                        capacity_logged = true;
                    }
                    continue;
                }

                let now = Instant::now();
                if now < next_tick {
                    std::thread::sleep(next_tick - now);
                }
                next_tick += interval;

                let elapsed_ms = (Instant::now().saturating_duration_since(start_instant)
                    - paused_duration)
                    .as_millis() as u64;

                let click_markers = click_tracker
                    .as_mut()
                    .map(|tracker| {
                        tracker.snapshot(
                            Instant::now(),
                            screen_x,
                            screen_y,
                            width as i32,
                            height as i32,
                        )
                    })
                    .unwrap_or_default();

                match capture_frame_with_cursor(
                    screen_x,
                    screen_y,
                    width as i32,
                    height as i32,
                    record_cursor,
                    &click_markers,
                ) {
                    Ok(pixels) => {
                        capture_errors = 0;
                        let frame_count = frames_clone
                            .lock()
                            .map(|frames| frames.len())
                            .unwrap_or(max_frames);
                        if frame_count >= max_frames {
                            capacity_reached_clone.store(true, Ordering::Relaxed);
                            state_clone.store(STATE_PAUSED, Ordering::Relaxed);
                            continue;
                        }

                        let offset = match cache_clone.append(&pixels) {
                            Ok(offset) => offset,
                            Err(error) => {
                                diagnostics::log(
                                    "ERROR",
                                    "recorder.worker",
                                    format!("recording cache append failed: {error}"),
                                );
                                capacity_reached_clone.store(true, Ordering::Relaxed);
                                state_clone.store(STATE_PAUSED, Ordering::Relaxed);
                                continue;
                            }
                        };
                        let mut f_lock = match frames_clone.lock() {
                            Ok(lock) => lock,
                            Err(_) => {
                                diagnostics::log(
                                    "ERROR",
                                    "recorder.worker",
                                    "recording frame index lock poisoned",
                                );
                                capacity_reached_clone.store(true, Ordering::Relaxed);
                                state_clone.store(STATE_PAUSED, Ordering::Relaxed);
                                continue;
                            }
                        };
                        if f_lock.len() >= max_frames {
                            capacity_reached_clone.store(true, Ordering::Relaxed);
                            state_clone.store(STATE_PAUSED, Ordering::Relaxed);
                            continue;
                        }
                        f_lock.push(RecordedFrame {
                            timestamp_ms: elapsed_ms,
                            pixels: Vec::new(),
                            disk_offset: Some(offset),
                        });
                    }
                    Err(error) => {
                        capture_errors = capture_errors.saturating_add(1);
                        if capture_errors <= 3 || capture_errors % 60 == 0 {
                            diagnostics::log(
                                "WARN",
                                "recorder.worker",
                                format!(
                                    "frame capture failed; consecutiveErrors={capture_errors}; error={error}"
                                ),
                            );
                        }
                    }
                }
            }
            diagnostics::log("INFO", "recorder.worker", "capture worker stopped");
        });

        Ok(Self {
            screen_x,
            screen_y,
            width,
            height,
            fps,
            overlay_hwnd,
            state,
            capacity_reached,
            frames,
            cache: Some(cache),
            preview_cache,
            worker: Some(worker),
        })
    }

    pub fn pause(&self) {
        diagnostics::log("INFO", "recorder", "pause requested");
        self.state.store(STATE_PAUSED, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        if !self.capacity_reached.load(Ordering::Relaxed) {
            diagnostics::log("INFO", "recorder", "resume requested");
            self.state.store(STATE_RECORDING, Ordering::Relaxed);
        } else {
            diagnostics::log("WARN", "recorder", "resume ignored after capacity reached");
        }
    }

    pub fn stop(&mut self) {
        let started = Instant::now();
        diagnostics::log("INFO", "recorder", "stop signal sent; waiting for capture worker");
        self.state.store(STATE_STOPPED, Ordering::Relaxed);
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
        diagnostics::log(
            "INFO",
            "recorder",
            format!("stop completed; workerWaitMs={}", started.elapsed().as_millis()),
        );
    }

    pub fn get_status(&self) -> RecordingStatus {
        let (frame_count, duration_ms) = self
            .frames
            .lock()
            .map(|frames| {
                (
                    frames.len().min(u32::MAX as usize) as u32,
                    frames.last().map(|frame| frame.timestamp_ms).unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        let state_val = self.state.load(Ordering::Relaxed);
        let state_str = match state_val {
            STATE_RECORDING => "recording",
            STATE_PAUSED => "paused",
            _ => "stopped",
        }
        .to_string();

        RecordingStatus {
            state: state_str,
            frame_count,
            duration_ms,
            width: self.width,
            height: self.height,
            fps: self.fps,
            capacity_reached: self.capacity_reached.load(Ordering::Relaxed),
        }
    }

    pub fn get_frame(&self, index: usize) -> Result<Vec<u8>, String> {
        let frame = self
            .frames
            .lock()
            .map_err(|_| "frames lock poisoned")?
            .get(index)
            .cloned()
            .ok_or_else(|| "帧索引超出范围".to_string())?;
        self.read_recorded_frame(&frame)
    }

    fn read_recorded_frame(&self, frame: &RecordedFrame) -> Result<Vec<u8>, String> {
        if let Some(offset) = frame.disk_offset {
            return self
                .cache
                .as_ref()
                .ok_or_else(|| "录制缓存已释放".to_string())?
                .read_frame(offset);
        }
        if frame.pixels.len()
            != (self.width as usize)
                .checked_mul(self.height as usize)
                .and_then(|size| size.checked_mul(4))
                .unwrap_or(0)
        {
            return Err("录制帧尺寸不匹配".to_string());
        }
        Ok(frame.pixels.clone())
    }

    fn preview_layout(&self, max_dim: u32, source_frames: usize) -> (u32, u32, usize) {
        // Keep the source dimensions by default. The preview memory budget
        // still limits how many frames are sampled, so high-resolution
        // recordings remain usable without shrinking their pixels.
        let max_dim = max_dim.max(16);
        let scale = if self.width > max_dim || self.height > max_dim {
            (max_dim as f32 / self.width as f32).min(max_dim as f32 / self.height as f32)
        } else {
            1.0
        };
        let target_w = ((self.width as f32 * scale).round() as u32).max(16);
        let target_h = ((self.height as f32 * scale).round() as u32).max(16);
        let preview_frame_size = target_w as usize * target_h as usize * 4;
        let memory_limited_frames = (MAX_PREVIEW_BYTES / preview_frame_size).max(1);
        let wanted_frames = source_frames
            .min(MAX_PREVIEW_FRAMES)
            .min(memory_limited_frames)
            .max(1);
        let step = source_frames.div_ceil(wanted_frames).max(1);
        (target_w, target_h, step)
    }

    pub fn get_preview_info(&self, max_dim: u32) -> PreviewFramesResult {
        let source_frames = self.frames.lock().map(|frames| frames.len()).unwrap_or(0);
        if source_frames == 0 {
            diagnostics::log("WARN", "recorder.preview", "preview info requested with zero frames");
            return PreviewFramesResult {
                width: self.width,
                height: self.height,
                frame_count: 0,
                pixels: Vec::new(),
            };
        }
        let (width, height, step) = self.preview_layout(max_dim, source_frames);
        diagnostics::log(
            "INFO",
            "recorder.preview",
            format!(
                "preview info; sourceFrames={source_frames}; target={}x{}; sampledFrames={}",
                width,
                height,
                source_frames.div_ceil(step)
            ),
        );
        PreviewFramesResult {
            width,
            height,
            frame_count: source_frames.div_ceil(step) as u32,
            pixels: Vec::new(),
        }
    }

    pub fn get_preview_frames(&self, max_dim: u32) -> Result<PreviewFramesResult, String> {
        let started = Instant::now();
        let max_dim = max_dim.max(16);
        if let Ok(cache_lock) = self.preview_cache.lock() {
            if let Some((cached_dim, ref cached_res)) = *cache_lock {
                if cached_dim == max_dim {
                    diagnostics::log(
                        "INFO",
                        "recorder.preview",
                        format!(
                            "preview cache hit; maxDim={max_dim}; frames={}; bytes={}",
                            cached_res.frame_count,
                            cached_res.pixels.len()
                        ),
                    );
                    return Ok(cached_res.clone());
                }
            }
        }

        let (source_frame_count, selected_frames) = {
            let f_lock = self.frames.lock().map_err(|_| "frames lock poisoned")?;
            let source_frame_count = f_lock.len();
            if source_frame_count == 0 {
                return Ok(PreviewFramesResult {
                    width: self.width,
                    height: self.height,
                    frame_count: 0,
                    pixels: Vec::new(),
                });
            }
            let (_, _, step) = self.preview_layout(max_dim, source_frame_count);
            (
                source_frame_count,
                f_lock.iter().step_by(step).cloned().collect::<Vec<_>>(),
            )
        };

        let (target_w, target_h, step) = self.preview_layout(max_dim, source_frame_count);
        let preview_frame_size = (target_w * target_h * 4) as usize;
        let preview_frame_count = source_frame_count.div_ceil(step);
        let mut all_pixels = Vec::with_capacity(preview_frame_count * preview_frame_size);

        for frame in &selected_frames {
            let pixels = self.read_recorded_frame(frame)?;
            if target_w == self.width && target_h == self.height {
                all_pixels.extend_from_slice(&pixels);
            } else if let Some(img) = RgbaImage::from_raw(self.width, self.height, pixels) {
                let resized = imageops::resize(
                    &img,
                    target_w,
                    target_h,
                    imageops::FilterType::CatmullRom,
                );
                all_pixels.extend_from_slice(resized.as_raw());
            } else {
                return Err("图像像素解析失败".to_string());
            }
        }

        let result = PreviewFramesResult {
            width: target_w,
            height: target_h,
            frame_count: preview_frame_count as u32,
            pixels: all_pixels,
        };

        diagnostics::log(
            "INFO",
            "recorder.preview",
            format!(
                "preview frames ready; sourceFrames={source_frame_count}; frames={}; size={}x{}; bytes={}; elapsedMs={}",
                result.frame_count,
                result.width,
                result.height,
                result.pixels.len(),
                started.elapsed().as_millis()
            ),
        );

        if let Ok(mut cache_lock) = self.preview_cache.lock() {
            *cache_lock = Some((max_dim, result.clone()));
        }

        Ok(result)
    }

    pub fn encode_gif(&self, options: &GifExportOptions) -> Result<Vec<u8>, String> {
        self.encode_gif_with_progress(options, |_, _| true)
    }

    /// Encodes the recording while reporting completed frames.  Keeping the
    /// callback here (next to the frame-reading loop) avoids a second pass over
    /// the cache just to estimate progress.
    pub fn encode_gif_with_progress<F>(
        &self,
        options: &GifExportOptions,
        mut on_progress: F,
    ) -> Result<Vec<u8>, String>
    where
        F: FnMut(usize, usize) -> bool,
    {
        let frames = self
            .frames
            .lock()
            .map_err(|_| "frames lock poisoned")?
            .clone();
        if frames.is_empty() {
            return Err("没有录制到有效帧".into());
        }

        let speed = options.speed.unwrap_or(1.0).clamp(0.25, 4.0);
        let quality = options.quality.unwrap_or(10).clamp(1, 30);
        let scale = options.scale.unwrap_or(1.0).clamp(0.2, 1.0);

        let target_w = ((self.width as f32 * scale).round() as u32).max(16);
        let target_h = ((self.height as f32 * scale).round() as u32).max(16);

        // Frame sampling if target_fps is specified and lower than recorded fps
        let step = if let Some(target_fps) = options.target_fps.filter(|fps| *fps > 0) {
            if target_fps < self.fps {
                (self.fps / target_fps).max(1) as usize
            } else {
                1
            }
        } else {
            1
        };

        let selected_frames: Vec<&RecordedFrame> = frames.iter().step_by(step).collect();

        if selected_frames.is_empty() {
            return Err("没有可用的帧数据".into());
        }

        let mut output = Vec::new();
        {
            let mut encoder = GifEncoder::new_with_speed(&mut output, quality);
            encoder
                .set_repeat(Repeat::Infinite)
                .map_err(|e| format!("设置 GIF 循环失败: {e}"))?;

            let default_interval_ms = (1000.0 / (self.fps as f32 * speed)) as u32;

            // Keep one pending frame so consecutive identical frames can be
            // merged into its delay. This mirrors ScreenToGif's unchanged
            // frame optimization without changing the visible timing.
            let mut pending: Option<(RgbaImage, u64)> = None;
            let mut last_timestamp_ms = 0u64;
            for (idx, frame_data) in selected_frames.iter().enumerate() {
                last_timestamp_ms = frame_data.timestamp_ms;
                let img = RgbaImage::from_raw(
                    self.width,
                    self.height,
                    self.read_recorded_frame(frame_data)?,
                )
                .ok_or_else(|| "图像像素解析失败".to_string())?;

                let final_img = if target_w != self.width || target_h != self.height {
                    imageops::resize(&img, target_w, target_h, imageops::FilterType::Triangle)
                } else {
                    img
                };

                if let Some((pending_img, pending_timestamp)) = pending.take() {
                    if pending_img.as_raw() == final_img.as_raw() {
                        pending = Some((pending_img, pending_timestamp));
                    } else {
                        let diff = frame_data
                            .timestamp_ms
                            .saturating_sub(pending_timestamp);
                        let delay_ms = ((diff as f32 / speed).round() as u32).clamp(20, 1000);
                        let delay = Delay::from_numer_denom_ms(delay_ms, 1);
                        encoder
                            .encode_frame(Frame::from_parts(pending_img, 0, 0, delay))
                            .map_err(|e| format!("编码 GIF 帧失败: {e}"))?;
                        pending = Some((final_img, frame_data.timestamp_ms));
                    }
                } else {
                    pending = Some((final_img, frame_data.timestamp_ms));
                }
                if !on_progress(idx + 1, selected_frames.len()) {
                    return Err("录制导出已取消".into());
                }
            }

            if let Some((final_img, pending_timestamp)) = pending {
                let trailing_elapsed = last_timestamp_ms
                    .saturating_sub(pending_timestamp);
                let trailing_delay = ((trailing_elapsed as f32 / speed).round() as u32)
                    .saturating_add(default_interval_ms)
                    .clamp(20, 1000);
                let delay = Delay::from_numer_denom_ms(trailing_delay, 1);
                encoder
                    .encode_frame(Frame::from_parts(final_img, 0, 0, delay))
                    .map_err(|e| format!("编码 GIF 帧失败: {e}"))?;
            }
        }

        Ok(output)
    }
}

impl Drop for ActiveRecordingSession {
    fn drop(&mut self) {
        self.state.store(STATE_STOPPED, Ordering::Relaxed);
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frame_cache_round_trip_and_cleanup() {
        let cache = FrameCache::create(4).unwrap();
        let path = cache.path.clone();
        let offset = cache.append(&[1, 2, 3, 4]).unwrap();
        assert_eq!(offset, 0);
        assert_eq!(cache.read_frame(offset).unwrap(), vec![1, 2, 3, 4]);
        drop(cache);
        assert!(!path.exists());
    }

    #[test]
    fn test_encode_gif() {
        let w = 48;
        let h = 48;
        let f1 = vec![255u8; (w * h * 4) as usize];
        let mut f2 = vec![0u8; (w * h * 4) as usize];
        for chunk in f2.chunks_exact_mut(4) {
            chunk[0] = 255;
            chunk[3] = 255;
        }

        let frames = Arc::new(Mutex::new(vec![
            RecordedFrame {
                timestamp_ms: 0,
                pixels: f1,
                disk_offset: None,
            },
            RecordedFrame {
                timestamp_ms: 100,
                pixels: f2,
                disk_offset: None,
            },
        ]));

        let session = ActiveRecordingSession {
            screen_x: 0,
            screen_y: 0,
            width: w,
            height: h,
            fps: 10,
            overlay_hwnd: 0,
            state: Arc::new(AtomicU8::new(STATE_STOPPED)),
            capacity_reached: Arc::new(AtomicBool::new(false)),
            frames,
            cache: None,
            preview_cache: Arc::new(Mutex::new(None)),
            worker: None,
        };

        let gif = session
            .encode_gif(&GifExportOptions {
                speed: Some(1.0),
                quality: Some(15),
                scale: Some(1.0),
                // IPC callers can supply this directly; zero must not cause
                // the frame-sampling calculation to divide by zero.
                target_fps: Some(0),
            })
            .unwrap();

        assert!(!gif.is_empty());
        assert_eq!(&gif[0..3], b"GIF");
    }

    #[test]
    fn test_preview_keeps_native_dimensions() {
        let width = 1326;
        let height = 605;
        let frame_bytes = (width * height * 4) as usize;
        let frames = Arc::new(Mutex::new(vec![RecordedFrame {
            timestamp_ms: 0,
            pixels: vec![0; frame_bytes],
            disk_offset: None,
        }]));
        let session = ActiveRecordingSession {
            screen_x: 0,
            screen_y: 0,
            width,
            height,
            fps: 24,
            overlay_hwnd: 0,
            state: Arc::new(AtomicU8::new(STATE_STOPPED)),
            capacity_reached: Arc::new(AtomicBool::new(false)),
            frames,
            cache: None,
            preview_cache: Arc::new(Mutex::new(None)),
            worker: None,
        };

        let preview = session.get_preview_info(u32::MAX);
        assert_eq!((preview.width, preview.height), (width, height));
    }

    #[test]
    fn test_recording_frames() {
        let mut session = ActiveRecordingSession::start(0, 0, 100, 100, 15, false, 0).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        session.stop();
        let status = session.get_status();
        println!("status: {:?}", status);
        assert!(status.frame_count > 0);
        let total_bytes: usize = (0..status.frame_count as usize)
            .map(|index| session.get_frame(index).unwrap().len())
            .sum();
        assert_eq!(total_bytes, (100 * 100 * 4 * status.frame_count) as usize);
    }
}
