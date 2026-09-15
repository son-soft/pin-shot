use std::mem::size_of;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetOpenClipboardWindow, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use crate::diagnostics;

// Clipboard ownership is process-wide, not window-wide. Tauri can dispatch
// commands from several webviews at the same time, so serialize all clipboard
// transactions inside this process as well as retrying external owners.
static CLIPBOARD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

const OPEN_CLIPBOARD_ATTEMPTS: usize = 40;
const OPEN_CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(25);

fn clipboard_lock() -> &'static Mutex<()> {
    CLIPBOARD_LOCK.get_or_init(|| Mutex::new(()))
}

fn error_details(error: &windows::core::Error) -> String {
    format!(
        "{} (hresult=0x{:08x})",
        error.message(),
        error.code().0 as u32,
    )
}

fn owner_details(hwnd: HWND) -> String {
    if hwnd == HWND::default() {
        "none".to_string()
    } else {
        format!("0x{:x}", hwnd.0 as usize)
    }
}

struct ClipboardHolder {
    hwnd: HWND,
    pid: u32,
    process_name: String,
}

impl ClipboardHolder {
    fn details(&self) -> String {
        format!(
            "heldByWindow={}; heldByPid={}; heldByProcess={}",
            owner_details(self.hwnd), self.pid, self.process_name,
        )
    }

    fn user_message(&self) -> String {
        if self.pid != 0 && self.pid != std::process::id() {
            let title = if self.process_name != "unknown" {
                format!("剪贴板被 {} 占用", self.process_name)
            } else {
                "剪贴板被其他程序占用".to_string()
            };
            format!("{title}\n请关闭该程序的剪贴板同步，或退出该程序后重试")
        } else {
            // A NULL opener or a race can hide the holder; do not accuse an
            // application that we could not actually identify.
            "剪贴板暂时无法访问\n请稍后重试；若仍失败，请暂停远程软件的剪贴板同步".to_string()
        }
    }
}

fn clipboard_holder() -> ClipboardHolder {
    unsafe {
        // The window holding the clipboard open can differ from the owner of
        // its contents (for example, a remote clipboard synchronization app).
        let hwnd = GetOpenClipboardWindow().unwrap_or_default();
        let mut pid = 0;
        if hwnd != HWND::default() {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        let mut process_name = "unknown".to_string();
        if pid != 0 {
            if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buffer = vec![0u16; 32768];
                let mut length = buffer.len() as u32;
                let result = QueryFullProcessImageNameW(
                    process,
                    PROCESS_NAME_WIN32,
                    windows::core::PWSTR(buffer.as_mut_ptr()),
                    &mut length,
                );
                let _ = CloseHandle(process);
                if result.is_ok() {
                    let path = String::from_utf16_lossy(&buffer[..length as usize]);
                    if let Some(name) = std::path::Path::new(&path).file_name() {
                        process_name = name.to_string_lossy().into_owned();
                    }
                }
            }
        }
        ClipboardHolder { hwnd, pid, process_name }
    }
}

struct ClipboardGuard {
    opened: bool,
}

impl ClipboardGuard {
    unsafe fn open(hwnd: HWND, operation: &str) -> windows::core::Result<Self> {
        let owner = if hwnd == HWND::default() {
            None
        } else {
            Some(hwnd)
        };
        let owner_text = owner_details(hwnd);
        let mut last_error = None;
        let mut last_holder = None;

        for attempt in 1..=OPEN_CLIPBOARD_ATTEMPTS {
            match OpenClipboard(owner) {
                Ok(()) => {
                    if attempt > 1 {
                        diagnostics::log(
                            "WARN",
                            "clipboard",
                            format!(
                                "{operation}: clipboard was busy; opened after {} retries; owner={owner_text}",
                                attempt - 1,
                            ),
                        );
                    }
                    return Ok(Self { opened: true });
                }
                Err(error) => {
                    if attempt == 1 || attempt == OPEN_CLIPBOARD_ATTEMPTS {
                        let holder = clipboard_holder();
                        diagnostics::log(
                            "WARN",
                            "clipboard",
                            format!(
                                "{operation}: OpenClipboard attempt {attempt}/{OPEN_CLIPBOARD_ATTEMPTS} failed; owner={owner_text}; error={}; {}",
                                error_details(&error),
                                holder.details(),
                            ),
                        );
                        last_holder = Some(holder);
                    }
                    last_error = Some(error);
                    if attempt < OPEN_CLIPBOARD_ATTEMPTS {
                        std::thread::sleep(OPEN_CLIPBOARD_RETRY_DELAY);
                    }
                }
            }
        }

        let error = last_error.unwrap_or_else(windows::core::Error::from_win32);
        diagnostics::log(
            "ERROR",
            "clipboard",
            format!(
                "{operation}: OpenClipboard gave up after {OPEN_CLIPBOARD_ATTEMPTS} attempts; owner={owner_text}; error={}",
                error_details(&error),
            ),
        );
        let holder = last_holder.unwrap_or_else(clipboard_holder);
        Err(windows::core::Error::new(error.code(), holder.user_message()))
    }

    unsafe fn close(&mut self) -> windows::core::Result<()> {
        if !self.opened {
            return Ok(());
        }

        let result = CloseClipboard();
        if result.is_ok() {
            self.opened = false;
        }
        result
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        if self.opened {
            // Cleanup must not panic or replace the operation's useful error.
            unsafe {
                let _ = CloseClipboard();
            }
            self.opened = false;
        }
    }
}

struct GlobalMemory {
    handle: HGLOBAL,
    transferred: bool,
}

impl GlobalMemory {
    unsafe fn from_bytes(data: &[u8]) -> windows::core::Result<Self> {
        let handle = GlobalAlloc(GMEM_MOVEABLE, data.len())?;
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            let error = windows::core::Error::from_win32();
            let _ = GlobalFree(Some(handle));
            return Err(error);
        }

        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
        // GlobalUnlock returns zero both when it succeeds in releasing the
        // final lock and when it fails; the clipboard only needs the block to
        // be unlocked, so keep the existing best-effort behavior here.
        let _ = GlobalUnlock(handle);

        Ok(Self {
            handle,
            transferred: false,
        })
    }

    unsafe fn transfer_to_clipboard(mut self, format: u32) -> windows::core::Result<()> {
        match SetClipboardData(format, Some(HANDLE(self.handle.0))) {
            Ok(_) => {
                // Windows owns the HGLOBAL after SetClipboardData succeeds.
                self.transferred = true;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

impl Drop for GlobalMemory {
    fn drop(&mut self) {
        if !self.transferred {
            unsafe {
                let _ = GlobalFree(Some(self.handle));
            }
        }
    }
}

fn with_open_clipboard<T>(
    hwnd: HWND,
    operation: &str,
    action: impl FnOnce() -> windows::core::Result<T>,
) -> windows::core::Result<T> {
    let lock = match clipboard_lock().lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            diagnostics::log(
                "WARN",
                "clipboard",
                format!("{operation}: clipboard lock was poisoned; recovering"),
            );
            poisoned.into_inner()
        }
    };

    let mut clipboard = match unsafe { ClipboardGuard::open(hwnd, operation) } {
        Ok(clipboard) => clipboard,
        Err(error) => {
            drop(lock);
            return Err(error);
        }
    };

    let result = action();
    if let Err(error) = &result {
        diagnostics::log(
            "ERROR",
            "clipboard",
            format!(
                "{operation} failed while clipboard was open: {}",
                error_details(error)
            ),
        );
    }

    // Once SetClipboardData succeeds, the data is already owned by Windows.
    // A rare CloseClipboard failure should not turn a successful copy into a
    // user-visible failure, but it is still recorded and retried by Drop.
    if let Err(error) = unsafe { clipboard.close() } {
        diagnostics::log(
            "WARN",
            "clipboard",
            format!(
                "{operation}: CloseClipboard failed: {}",
                error_details(&error)
            ),
        );
    }

    if result.is_ok() {
        diagnostics::log("INFO", "clipboard", format!("{operation} completed"));
    }
    // Run the guard's fallback cleanup while the process-local lock is still
    // held, so a failed first close cannot race the next clipboard request.
    drop(clipboard);
    drop(lock);
    result
}

fn expected_rgba_len(width: i32, height: i32) -> Option<usize> {
    if width <= 0 || height <= 0 {
        return None;
    }
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
}

fn build_dib(rgba: &[u8], width: i32, height: i32) -> windows::core::Result<Vec<u8>> {
    let Some(expected) = expected_rgba_len(width, height) else {
        return Err(windows::core::Error::from_win32());
    };
    if rgba.len() != expected {
        return Err(windows::core::Error::from_win32());
    }

    let stride = width as usize * 4;
    let mut dib_pixels = vec![0; rgba.len()];
    for row in 0..height as usize {
        let src = row * stride;
        let dst = (height as usize - row - 1) * stride;
        for (out, input) in dib_pixels[dst..dst + stride]
            .chunks_exact_mut(4)
            .zip(rgba[src..src + stride].chunks_exact(4))
        {
            out[0] = input[2];
            out[1] = input[1];
            out[2] = input[0];
            out[3] = 0xff;
        }
    }

    let header = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        // BI_RGB permits this field to be zero. Avoid truncating a very large
        // usize to u32 if a future caller raises the image-size limit.
        biSizeImage: u32::try_from(dib_pixels.len()).unwrap_or(0),
        ..Default::default()
    };
    let header_bytes = unsafe {
        std::slice::from_raw_parts(
            &header as *const _ as *const u8,
            size_of::<BITMAPINFOHEADER>(),
        )
    };
    let mut data = Vec::with_capacity(header_bytes.len() + dib_pixels.len());
    data.extend_from_slice(header_bytes);
    data.extend_from_slice(&dib_pixels);
    Ok(data)
}

pub fn copy_rgba_to_clipboard(
    hwnd: HWND,
    rgba: &[u8],
    width: i32,
    height: i32,
) -> windows::core::Result<()> {
    let Some(expected) = expected_rgba_len(width, height) else {
        diagnostics::log(
            "ERROR",
            "clipboard",
            format!(
                "copy image rejected: invalid size={}x{}; bytes={}",
                width,
                height,
                rgba.len()
            ),
        );
        return Err(windows::core::Error::from_win32());
    };
    if rgba.len() != expected {
        diagnostics::log(
            "ERROR",
            "clipboard",
            format!(
                "copy image rejected: pixel buffer mismatch; size={}x{}; expectedBytes={expected}; actualBytes={}",
                width,
                height,
                rgba.len(),
            ),
        );
        return Err(windows::core::Error::from_win32());
    }

    // Prepare and validate the complete payload before opening the clipboard.
    // This keeps the system clipboard locked only for the Empty/Set pair.
    let data = build_dib(rgba, width, height)?;
    let operation = format!("copy image size={}x{} bytes={}", width, height, rgba.len());
    with_open_clipboard(hwnd, &operation, || unsafe {
        EmptyClipboard()?;
        let memory = GlobalMemory::from_bytes(&data)?;
        memory.transfer_to_clipboard(CF_DIB.0 as u32)
    })
}

pub fn copy_text_to_clipboard(hwnd: HWND, text: &str) -> windows::core::Result<()> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let size = wide.len() * std::mem::size_of::<u16>();
    let operation = format!("copy text chars={} bytes={size}", text.chars().count());

    with_open_clipboard(hwnd, &operation, || unsafe {
        EmptyClipboard()?;
        let memory =
            GlobalMemory::from_bytes(std::slice::from_raw_parts(wide.as_ptr() as *const u8, size))?;
        memory.transfer_to_clipboard(CF_UNICODETEXT.0 as u32)
    })
}

#[repr(C)]
struct DropFilesHeader {
    p_files: u32,
    pt_x: i32,
    pt_y: i32,
    f_nc: i32,
    f_wide: i32,
}

pub fn copy_file_to_clipboard(
    hwnd: HWND,
    file_path: &std::path::Path,
) -> windows::core::Result<()> {
    let abs_path = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(file_path)
    };
    let path_str = abs_path.to_string_lossy();
    let mut wide_chars: Vec<u16> = path_str.encode_utf16().collect();
    wide_chars.push(0);
    wide_chars.push(0); // double-null terminated string list

    let header = DropFilesHeader {
        p_files: size_of::<DropFilesHeader>() as u32,
        pt_x: 0,
        pt_y: 0,
        f_nc: 0,
        f_wide: 1,
    };

    let header_size = size_of::<DropFilesHeader>();
    let total_size = header_size + wide_chars.len() * size_of::<u16>();
    let operation = format!("copy file path chars={}", path_str.chars().count());

    with_open_clipboard(hwnd, &operation, || unsafe {
        EmptyClipboard()?;
        let mut data = Vec::with_capacity(total_size);
        data.extend_from_slice(std::slice::from_raw_parts(
            &header as *const _ as *const u8,
            header_size,
        ));
        data.extend_from_slice(std::slice::from_raw_parts(
            wide_chars.as_ptr() as *const u8,
            wide_chars.len() * size_of::<u16>(),
        ));
        let memory = GlobalMemory::from_bytes(&data)?;
        memory.transfer_to_clipboard(15)
    })
}

#[cfg(test)]
mod tests {
    use super::{build_dib, expected_rgba_len};

    #[test]
    fn expected_rgba_len_rejects_invalid_dimensions() {
        assert_eq!(expected_rgba_len(0, 1), None);
        assert_eq!(expected_rgba_len(-1, 1), None);
        assert_eq!(expected_rgba_len(2, 3), Some(24));
    }

    #[test]
    fn build_dib_flips_rows_and_converts_rgba_to_bgra() {
        let rgba = [
            0xff, 0x00, 0x00, 0xff, // red, top row
            0x00, 0x00, 0xff, 0xff, // blue, bottom row
        ];
        let dib = build_dib(&rgba, 1, 2).unwrap();
        let header_size = std::mem::size_of::<windows::Win32::Graphics::Gdi::BITMAPINFOHEADER>();
        assert_eq!(
            &dib[header_size..],
            &[0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0xff]
        );
    }
}
