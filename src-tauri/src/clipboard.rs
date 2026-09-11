use std::mem::size_of;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};

pub fn copy_rgba_to_clipboard(
    hwnd: HWND,
    rgba: &[u8],
    width: i32,
    height: i32,
) -> windows::core::Result<()> {
    if width <= 0 || height <= 0 || rgba.len() != width as usize * height as usize * 4 {
        return Err(windows::core::Error::from_win32());
    }
    unsafe {
        let owner = if hwnd == HWND::default() { None } else { Some(hwnd) };
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(owner).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            OpenClipboard(owner)?;
        }
        let result = (|| -> windows::core::Result<()> {
            EmptyClipboard()?;
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
                biSizeImage: dib_pixels.len() as u32,
                ..Default::default()
            };
            let header_bytes = std::slice::from_raw_parts(
                &header as *const _ as *const u8,
                size_of::<BITMAPINFOHEADER>(),
            );
            let mut data = Vec::with_capacity(header_bytes.len() + dib_pixels.len());
            data.extend_from_slice(header_bytes);
            data.extend_from_slice(&dib_pixels);
            let handle = GlobalAlloc(GMEM_MOVEABLE, data.len())?;
            let ptr = GlobalLock(handle);
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
            let _ = GlobalUnlock(handle);
            SetClipboardData(
                CF_DIB.0 as u32,
                Some(windows::Win32::Foundation::HANDLE(handle.0)),
            )?;
            CloseClipboard()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = CloseClipboard();
        }
        result
    }
}

pub fn copy_text_to_clipboard(
    hwnd: HWND,
    text: &str,
) -> windows::core::Result<()> {
    unsafe {
        let owner = if hwnd == HWND::default() { None } else { Some(hwnd) };
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(owner).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            OpenClipboard(owner)?;
        }
        let result = (|| -> windows::core::Result<()> {
            EmptyClipboard()?;
            let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let size = wide.len() * std::mem::size_of::<u16>();
            let handle = GlobalAlloc(GMEM_MOVEABLE, size)?;
            let ptr = GlobalLock(handle);
            std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr as *mut u8, size);
            let _ = GlobalUnlock(handle);
            SetClipboardData(
                CF_UNICODETEXT.0 as u32,
                Some(windows::Win32::Foundation::HANDLE(handle.0)),
            )?;
            CloseClipboard()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = CloseClipboard();
        }
        result
    }
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

    unsafe {
        let owner = if hwnd == HWND::default() { None } else { Some(hwnd) };
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(owner).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            OpenClipboard(owner)?;
        }
        let result = (|| -> windows::core::Result<()> {
            EmptyClipboard()?;
            let handle = GlobalAlloc(GMEM_MOVEABLE, total_size)?;
            let ptr = GlobalLock(handle) as *mut u8;
            std::ptr::copy_nonoverlapping(
                &header as *const _ as *const u8,
                ptr,
                header_size,
            );
            std::ptr::copy_nonoverlapping(
                wide_chars.as_ptr() as *const u8,
                ptr.add(header_size),
                wide_chars.len() * size_of::<u16>(),
            );
            let _ = GlobalUnlock(handle);
            const CF_HDROP_VAL: u32 = 15;
            SetClipboardData(
                CF_HDROP_VAL,
                Some(windows::Win32::Foundation::HANDLE(handle.0)),
            )?;
            CloseClipboard()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = CloseClipboard();
        }
        result
    }
}
