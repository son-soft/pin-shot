use crate::utils::VirtualScreen;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedWindow {
    pub id: u32,
    pub parent_id: Option<u32>,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub title: Option<String>,
}

#[cfg(windows)]
pub fn detect_visible_windows(screen: &VirtualScreen) -> Vec<DetectedWindow> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    };

    struct WindowContext<'a> {
        screen: &'a VirtualScreen,
        windows: Vec<DetectedWindow>,
        current_pid: u32,
        next_id: u32,
    }

    let mut context = WindowContext {
        screen,
        windows: Vec::new(),
        current_pid: std::process::id(),
        next_id: 1,
    };

    unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut WindowContext);

        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == ctx.current_pid {
            return BOOL(1); // Exclude our own application windows
        }

        let mut cloaked = 0u32;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if hr.is_ok() && cloaked != 0 {
            return BOOL(1);
        }

        let mut frame_rect = RECT::default();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame_rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );

        let rect = if hr.is_ok()
            && (frame_rect.right > frame_rect.left)
            && (frame_rect.bottom > frame_rect.top)
        {
            frame_rect
        } else {
            let mut gdi_rect = RECT::default();
            if GetWindowRect(hwnd, &mut gdi_rect).is_err() {
                return BOOL(1);
            }
            gdi_rect
        };

        let screen_right = ctx.screen.x + ctx.screen.width;
        let screen_bottom = ctx.screen.y + ctx.screen.height;

        let left = rect.left.max(ctx.screen.x);
        let top = rect.top.max(ctx.screen.y);
        let right = rect.right.min(screen_right);
        let bottom = rect.bottom.min(screen_bottom);

        let width = right - left;
        let height = bottom - top;

        if width < 32 || height < 32 {
            return BOOL(1);
        }

        let title_len = GetWindowTextLengthW(hwnd);
        let title = if title_len > 0 {
            let mut buf = vec![0u16; (title_len + 1) as usize];
            let actual = GetWindowTextW(hwnd, &mut buf);
            if actual > 0 {
                let s = String::from_utf16_lossy(&buf[..actual as usize]);
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            } else {
                None
            }
        } else {
            None
        };

        let window_id = ctx.next_id;
        ctx.next_id += 1;

        ctx.windows.push(DetectedWindow {
            id: window_id,
            parent_id: None,
            x: left - ctx.screen.x,
            y: top - ctx.screen.y,
            width,
            height,
            title,
        });

        // Enumerate prominent child windows (panels, tab bars, toolbars)
        struct ChildContext<'a> {
            parent_id: u32,
            parent_rect: RECT,
            screen: &'a VirtualScreen,
            children: Vec<DetectedWindow>,
            count: usize,
            next_id: &'a mut u32,
        }

        let mut child_ctx = ChildContext {
            parent_id: window_id,
            parent_rect: rect,
            screen: ctx.screen,
            children: Vec::new(),
            count: 0,
            next_id: &mut ctx.next_id,
        };

        unsafe extern "system" fn enum_child_callback(child: HWND, lparam: LPARAM) -> BOOL {
            let cctx = &mut *(lparam.0 as *mut ChildContext);
            if cctx.count >= 25 {
                return BOOL(0); // Cap per-window children for instant performance
            }

            if !IsWindowVisible(child).as_bool() || IsIconic(child).as_bool() {
                return BOOL(1);
            }

            let mut c_rect = RECT::default();
            if GetWindowRect(child, &mut c_rect).is_err() {
                return BOOL(1);
            }

            let c_width = c_rect.right - c_rect.left;
            let c_height = c_rect.bottom - c_rect.top;

            if c_width < 40 || c_height < 24 {
                return BOOL(1);
            }

            // Skip if identical or nearly identical to parent window
            if (c_rect.left - cctx.parent_rect.left).abs() < 6
                && (c_rect.top - cctx.parent_rect.top).abs() < 6
                && (c_rect.right - cctx.parent_rect.right).abs() < 6
                && (c_rect.bottom - cctx.parent_rect.bottom).abs() < 6
            {
                return BOOL(1);
            }

            let screen_right = cctx.screen.x + cctx.screen.width;
            let screen_bottom = cctx.screen.y + cctx.screen.height;

            let left = c_rect.left.max(cctx.screen.x);
            let top = c_rect.top.max(cctx.screen.y);
            let right = c_rect.right.min(screen_right);
            let bottom = c_rect.bottom.min(screen_bottom);

            let width = right - left;
            let height = bottom - top;

            if width < 40 || height < 24 {
                return BOOL(1);
            }

            let child_id = *cctx.next_id;
            *cctx.next_id += 1;

            cctx.children.push(DetectedWindow {
                id: child_id,
                parent_id: Some(cctx.parent_id),
                x: left - cctx.screen.x,
                y: top - cctx.screen.y,
                width,
                height,
                title: None,
            });
            cctx.count += 1;

            BOOL(1)
        }

        let _ = EnumChildWindows(
            Some(hwnd),
            Some(enum_child_callback),
            LPARAM(&mut child_ctx as *mut _ as isize),
        );

        ctx.windows.extend(child_ctx.children);

        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_callback),
            LPARAM(&mut context as *mut _ as isize),
        );
    }

    context.windows
}

#[cfg(not(windows))]
pub fn detect_visible_windows(_screen: &VirtualScreen) -> Vec<DetectedWindow> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_windows_structure() {
        let screen = VirtualScreen {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let wins = detect_visible_windows(&screen);
        for win in &wins {
            assert!(win.width >= 32);
            assert!(win.height >= 24);
            assert!(win.x >= 0);
            assert!(win.y >= 0);
        }
    }
}
