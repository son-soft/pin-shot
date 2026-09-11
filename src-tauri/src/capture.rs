use crate::diagnostics;
use crate::utils::{get_virtual_screen_bounds, VirtualScreen};
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};

#[cfg(test)]
mod desktop_tests {
    #[test]
    #[ignore = "interactive: requires numbered browser test page at (10,10)"]
    fn real_window_wheel_and_gdi_capture() {
        let before = super::capture_screen_rect(120, 160, 780, 720).unwrap();
        super::scroll_under_overlay(500, 500, -120).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let after = super::capture_screen_rect(120, 160, 780, 720).unwrap();
        image::save_buffer("../output/playwright/native-before.png", &before, 780, 720,
            image::ColorType::Rgba8).unwrap();
        image::save_buffer("../output/playwright/native-after.png", &after, 780, 720,
            image::ColorType::Rgba8).unwrap();
        let (shift, confidence) = crate::stitching::find_vertical_scroll_offset(&before, &after, 780, 720);
        eprintln!("native wheel shift={shift} confidence={confidence}");
        assert!(shift > 0, "native wheel must scroll the actual browser window");
    }
}

#[cfg(test)]
mod frame_tests {
    use super::frames_are_stable;

    #[test]
    fn stable_frame_check_allows_tiny_dynamic_detail() {
        let width = 200;
        let height = 300;
        let first = vec![32; (width * height * 4) as usize];
        let mut second = first.clone();
        second[17 * width as usize * 4 + 8] = 255;

        assert!(frames_are_stable(&first, &second, width, height));
    }

    #[test]
    fn stable_frame_check_rejects_horizontal_transition() {
        let width = 40;
        let height = 60;
        let first = vec![32; (width * height * 4) as usize];
        let mut second = first.clone();
        let row_start = 30 * width as usize * 4;
        for pixel in second[row_start..row_start + width as usize * 4].chunks_exact_mut(4) {
            pixel[0] = 255;
            pixel[1] = 255;
            pixel[2] = 255;
        }

        assert!(!frames_are_stable(&first, &second, width, height));
    }
}

#[derive(Clone)]
pub struct ScreenCapture {
    pub pixels: Vec<u8>,
    pub screen: VirtualScreen,
}

impl ScreenCapture {
    pub fn full_screen() -> windows::core::Result<Self> {
        let screen = get_virtual_screen_bounds();
        let mut pixels =
            unsafe { capture_region(screen.x, screen.y, screen.width, screen.height)? };
        // Canvas and Tauri IPC use RGBA; GDI returns BGRA.
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        Ok(Self { pixels, screen })
    }
}

pub fn capture_screen_rect(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> windows::core::Result<Vec<u8>> {
    let mut pixels = unsafe { capture_region(x, y, width, height)? };
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok(pixels)
}

/// Captures the screen only after three consecutive samples agree.  A browser
/// can still be in the middle of a compositor scroll after the wheel event
/// has returned; a single BitBlt during that transition may contain rows from
/// two different visual frames and will look torn when stitched.
pub fn capture_stable_screen_rect(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<Vec<u8>, String> {
    const SAMPLE_INTERVAL: Duration = Duration::from_millis(40);
    const STABILITY_TIMEOUT: Duration = Duration::from_millis(1200);

    // Give a just-delivered wheel event one compositor tick before sampling.
    std::thread::sleep(SAMPLE_INTERVAL);
    flush_desktop_compositor();
    let mut previous = capture_screen_rect(x, y, width, height).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + STABILITY_TIMEOUT;
    let mut stable_pairs = 0u8;

    while Instant::now() < deadline {
        std::thread::sleep(SAMPLE_INTERVAL);
        flush_desktop_compositor();
        let current = capture_screen_rect(x, y, width, height).map_err(|e| e.to_string())?;
        if frames_are_stable(&previous, &current, width, height) {
            stable_pairs += 1;
            if stable_pairs >= 2 {
                return Ok(current);
            }
        } else {
            stable_pairs = 0;
        }
        previous = current;
    }

    Err("页面仍在滚动，未捕获到稳定画面".to_string())
}

fn flush_desktop_compositor() {
    // BitBlt reads the composed desktop. Waiting for DWM before each sample
    // reduces the chance of reading one scanout while the browser is moving
    // another part of the window.
    unsafe {
        let _ = windows::Win32::Graphics::Dwm::DwmFlush();
    }
}

fn frames_are_stable(first: &[u8], second: &[u8], width: i32, height: i32) -> bool {
    let expected_len = (width.max(0) as usize)
        .checked_mul(height.max(0) as usize)
        .and_then(|pixels| pixels.checked_mul(4));
    if width <= 0
        || height <= 0
        || expected_len.is_none()
        || first.len() != second.len()
        || Some(first.len()) != expected_len
    {
        return false;
    }

    // Exact equality is the normal path and also avoids treating a thin
    // horizontal compositor tear as a stable frame.
    if first == second {
        return true;
    }

    // Allow tiny dynamic details such as a blinking caret, but reject a
    // meaningful row transition.  A tear usually changes a whole horizontal
    // band, so the per-row guard is more useful than a frame-wide average.
    let row_stride = width as usize * 4;
    let mut total_changed = 0usize;
    let mut total_diff = 0u64;
    let mut max_row_changed = 0usize;
    let mut pixel_count = 0usize;

    for y in 0..height as usize {
        let row_start = y * row_stride;
        let row_end = row_start + row_stride;
        let mut row_changed = 0usize;
        for (a, b) in first[row_start..row_end]
            .chunks_exact(4)
            .zip(second[row_start..row_end].chunks_exact(4))
        {
            let diff = (a[0] as i32 - b[0] as i32).unsigned_abs() as u64
                + (a[1] as i32 - b[1] as i32).unsigned_abs() as u64
                + (a[2] as i32 - b[2] as i32).unsigned_abs() as u64;
            total_diff += diff;
            pixel_count += 1;
            if diff >= 12 {
                total_changed += 1;
                row_changed += 1;
            }
        }
        max_row_changed = max_row_changed.max(row_changed);
    }

    let changed_ratio = total_changed as f64 / pixel_count.max(1) as f64;
    let mean_diff = total_diff as f64 / (pixel_count.max(1) * 3) as f64;
    let row_ratio = max_row_changed as f64 / width.max(1) as f64;

    changed_ratio <= 0.0002 && mean_diff <= 0.25 && row_ratio <= 0.03
}

/// Cuts out a rectangular hole in the overlay window so the underlying
/// application is directly visible, receives native mouse/wheel input,
/// and GDI BitBlt captures it with zero overlay interference.
pub fn punch_overlay_hole(
    hwnd: windows::Win32::Foundation::HWND,
    hole_x: i32,
    hole_y: i32,
    hole_w: i32,
    hole_h: i32,
    screen_w: i32,
    screen_h: i32,
) -> Result<(), String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
    };
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

    unsafe {
        let full_rgn = CreateRectRgn(0, 0, screen_w, screen_h);
        let hole_rgn = CreateRectRgn(hole_x, hole_y, hole_x + hole_w, hole_y + hole_h);
        let dest_rgn = CreateRectRgn(0, 0, 0, 0);
        CombineRgn(Some(dest_rgn), Some(full_rgn), Some(hole_rgn), RGN_DIFF);
        let _ = DeleteObject(full_rgn.into());
        let _ = DeleteObject(hole_rgn.into());

        let ret = SetWindowRgn(hwnd, Some(dest_rgn), true);
        if ret == 0 {
            let _ = DeleteObject(dest_rgn.into());
        }

        struct PunchParams {
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            sw: i32,
            sh: i32,
        }
        let params = PunchParams {
            x: hole_x,
            y: hole_y,
            w: hole_w,
            h: hole_h,
            sw: screen_w,
            sh: screen_h,
        };
        unsafe extern "system" fn enum_children(
            child: windows::Win32::Foundation::HWND,
            lparam: LPARAM,
        ) -> BOOL {
            let p = &*(lparam.0 as *const PunchParams);
            let full_rgn = CreateRectRgn(0, 0, p.sw, p.sh);
            let hole_rgn = CreateRectRgn(p.x, p.y, p.x + p.w, p.y + p.h);
            let dest_rgn = CreateRectRgn(0, 0, 0, 0);
            CombineRgn(Some(dest_rgn), Some(full_rgn), Some(hole_rgn), RGN_DIFF);
            let _ = DeleteObject(full_rgn.into());
            let _ = DeleteObject(hole_rgn.into());
            let r = SetWindowRgn(child, Some(dest_rgn), true);
            if r == 0 {
                let _ = DeleteObject(dest_rgn.into());
            }
            BOOL(1)
        }
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(enum_children),
            LPARAM(&params as *const _ as isize),
        );

        Ok(())
    }
}

/// Restores the overlay window to its full unclipped rectangle.
pub fn restore_overlay_region(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::SetWindowRgn;
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

    diagnostics::log("INFO", "overlay.region", "restore entered");
    unsafe {
        let _ = SetWindowRgn(hwnd, None, false);
        unsafe extern "system" fn enum_restore(
            child: windows::Win32::Foundation::HWND,
            _lparam: LPARAM,
        ) -> BOOL {
            let _ = SetWindowRgn(child, None, false);
            BOOL(1)
        }
        let _ = EnumChildWindows(Some(hwnd), Some(enum_restore), LPARAM(0));
        // RDW_UPDATENOW forces a synchronous WM_PAINT.  The restore call is
        // made while the WebView is awaiting the Tauri command response, so a
        // synchronous repaint can wait on that same WebView thread and make
        // the whole app appear hung exactly when recording stops. Invalidate
        // asynchronously and let the normal message loop repaint it.
        use windows::Win32::Graphics::Gdi::{
            RedrawWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_INVALIDATE,
        };
        let _ = RedrawWindow(
            Some(hwnd),
            None,
            None,
            RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN,
        );
        diagnostics::log("INFO", "overlay.region", "restore queued asynchronously");
        Ok(())
    }
}

/// Delivers a mouse wheel step to the target under the selection hole.
/// Since the overlay has a hole punched through it, the cursor at (x, y)
/// directly points to the underlying target application.
pub fn scroll_under_overlay(x: i32, y: i32, delta: i32) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{mouse_event, MOUSEEVENTF_WHEEL};
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
    unsafe {
        let _ = SetCursorPos(x, y);
        std::thread::sleep(std::time::Duration::from_millis(25));
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, 0);
        Ok(())
    }
}

unsafe fn capture_region(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> windows::core::Result<Vec<u8>> {
    if width <= 0 || height <= 0 {
        return Err(windows::core::Error::from_win32());
    }
    let screen_dc = GetDC(None);
    let mem_dc = CreateCompatibleDC(Some(screen_dc));
    let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
    let old_bitmap = SelectObject(mem_dc, bitmap.into());
    BitBlt(mem_dc, 0, 0, width, height, Some(screen_dc), x, y, SRCCOPY)?;
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: (width as i64 * height as i64 * 4) as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0; (width as usize) * (height as usize) * 4];
    GetDIBits(
        mem_dc,
        bitmap,
        0,
        height as u32,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    for pixel in pixels.chunks_exact_mut(4) {
        pixel[3] = 0xff;
    }
    SelectObject(mem_dc, old_bitmap);
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(mem_dc);
    ReleaseDC(None, screen_dc);
    Ok(pixels)
}
