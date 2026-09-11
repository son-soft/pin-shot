#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod clipboard;
mod click_indicator;
mod config;
mod diagnostics;
mod ocr;
mod recorder;
mod stitching;
mod utils;
mod window_detector;

use capture::ScreenCapture;
use config::{validate_save_directory, Config, HotkeyBinding, ThemeMode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Runtime, Size, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows::Win32::Foundation::HWND;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const OVERLAY_LABEL: &str = "overlay";

#[derive(Default)]
pub struct SharedState {
    pub config: Mutex<Config>,
    pub capture: Mutex<Option<CaptureSession>>,
    pub pins: Mutex<HashMap<String, PinData>>,
    pub hotkey: Mutex<Option<Shortcut>>,
    pub standby_pin: Mutex<Option<String>>,
    pub ocr: ocr::OcrService,
    pub history: Mutex<Vec<HistoryRecord>>,
    pub long_capture: Mutex<Option<LongCaptureSession>>,
    pub recording: Mutex<Option<recorder::ActiveRecordingSession>>,
    // Serializes startup/cancellation without blocking UI status readers.
    recording_start_gate: Mutex<()>,
    pub recording_export_cancelled: AtomicBool,
}

pub struct LongCaptureSession {
    pub session_id: String,
    pub stitcher: stitching::Stitcher,
    pub screen_x: i32,
    pub screen_y: i32,
    pub width: u32,
    pub height: u32,
    pub center_x: i32,
    pub center_y: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureStartResult {
    pub total_height: u32,
    pub frame_count: u32,
    pub preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureInfo {
    pub width: u32,
    pub height: u32,
}

pub struct CaptureSession {
    pub id: String,
    pub screen: utils::VirtualScreen,
    pub pixels: Vec<u8>,
    pub windows: Vec<window_detector::DetectedWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub width: i32,
    pub height: i32,
    pub x: i32,
    pub y: i32,
    pub timestamp: u64,
    pub time_str: String,
    pub action: String,
    pub path: Option<String>,
}

#[derive(Clone)]
pub struct HistoryRecord {
    pub item: HistoryItem,
    pub pixels: Vec<u8>,
}

#[derive(Clone)]
pub struct PinData {
    pub id: String,
    pub pixels: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub x: i32,
    pub y: i32,
    pub always_on_top: bool,
    pub click_through: bool,
    pub ghost_opacity: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub hotkey: HotkeyBinding,
    pub save_directory: Option<String>,
    pub autostart: bool,
    pub theme: ThemeMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDraft {
    pub hotkey: HotkeyBinding,
    pub save_directory: Option<String>,
    pub autostart: bool,
    pub theme: ThemeMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureManifest {
    pub session_id: String,
    pub screen_x: i32,
    pub screen_y: i32,
    pub width: i32,
    pub height: i32,
    pub pixel_format: &'static str,
    pub windows: Vec<window_detector::DetectedWindow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinManifest {
    pub pin_id: String,
    pub width: i32,
    pub height: i32,
    pub always_on_top: bool,
    pub click_through: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub action: String,
    pub path: Option<String>,
    pub pin_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastOptions {
    pub kind: Option<String>,
    pub path: Option<String>,
    pub message: Option<String>,
    pub subtext: Option<String>,
    pub duration: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastPayload {
    pub kind: String,
    pub path: Option<String>,
    pub message: String,
    pub subtext: Option<String>,
    pub duration: Option<u64>,
}

pub fn show_toast_window<R: Runtime>(app: &AppHandle<R>, payload: ToastPayload) {
    let window = match app.get_webview_window("toast") {
        Some(w) => w,
        None => return,
    };

    let size = window.outer_size().unwrap_or(PhysicalSize::new(440, 84));
    let (x, y) = utils::get_toast_position(size.width as i32, size.height as i32);
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    let _ = window.set_always_on_top(true);
    let _ = window.show();

    let _ = app.emit("show-toast", &payload);
    let _ = window.emit("show-toast", payload);

    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SW_SHOWNOACTIVATE,
        };
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    }
}

pub fn hide_toast_window<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
    let _ = window.hide();
}

pub fn show_save_toast<R: Runtime>(app: &AppHandle<R>, path: &str, message: &str) {
    show_toast_window(
        app,
        ToastPayload {
            kind: "save".to_string(),
            path: Some(path.to_string()),
            message: message.to_string(),
            subtext: None,
            duration: Some(4000),
        },
    );
}

#[allow(dead_code)]
pub fn show_copy_toast<R: Runtime>(app: &AppHandle<R>, message: &str) {
    show_toast_window(
        app,
        ToastPayload {
            kind: "copy".to_string(),
            path: None,
            message: message.to_string(),
            subtext: Some("已存入剪贴板，可直接粘贴 (Ctrl+V)".to_string()),
            duration: Some(2800),
        },
    );
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinAction {
    pub pin_id: String,
    pub action: String,
    pub opacity: Option<f64>,
}

pub fn run() {
    diagnostics::install_panic_hook();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            queue_settings(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        queue_capture(app);
                    }
                })
                .build(),
        )
        .manage(SharedState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            pick_save_directory,
            start_capture_from_ui,
            get_active_capture_id,
            get_capture_manifest,
            get_capture_pixels,
            overlay_ready,
            cancel_capture,
            complete_capture,
            get_pin_manifest,
            get_pin_pixels,
            get_pin_init_data,
            pin_ready,
            pin_action,
            show_in_folder,
            open_file,
            hide_toast,
            show_toast,
            ocr_pin,
            ocr_capture,
            copy_text_to_clipboard_cmd,
            get_history_item,
            get_history_items,
            get_history_pixels,
            restore_history_as_pin,
            copy_history_to_clipboard,
            save_history_to_file,
            delete_history_item,
            clear_history,
            show_history_shelf_from_ui,
            hide_history_shelf,
            start_long_capture,
            long_capture_scroll_step,
            long_capture_manual_frame,
            get_long_capture_preview,
            get_long_capture_info,
            get_long_capture_pixels,
            finish_long_capture,
            cancel_long_capture,
            start_screen_recording,
            pause_screen_recording,
            resume_screen_recording,
            get_screen_recording_status,
            stop_screen_recording,
            cancel_screen_recording,
            get_diagnostic_log_path,
            write_diagnostic_log,
            get_recording_preview_info,
            get_recording_preview_pixels,
            get_recording_frame,
            export_recording_gif,
            cancel_recording_export,
            save_recording_video,
            pick_recording_save_path,
        ])
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            if label == "toast" || label == "history" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if matches!(event, WindowEvent::Destroyed) {
                let state = window.state::<SharedState>();
                if label == OVERLAY_LABEL {
                    if let Ok(mut capture) = state.capture.lock() {
                        *capture = None;
                    }
                    if let Ok(mut lc) = state.long_capture.lock() {
                        *lc = None;
                    }
                    if let Ok(mut rec) = state.recording.lock() {
                        if let Some(mut s) = rec.take() {
                            s.stop();
                        }
                    }
                } else if let Some(id) = label.strip_prefix("pin-") {
                    if let Ok(mut pins) = state.pins.lock() {
                        pins.remove(id);
                    }
                    if let Ok(mut standby) = state.standby_pin.lock() {
                        if standby.as_deref() == Some(id) {
                            *standby = None;
                        }
                    }
                }
            }
        })
        .setup(|app| {
            diagnostics::log(
                "INFO",
                "app",
                format!(
                    "PinShot started; version={}; os={}; arch={}; log={}",
                    app.package_info().version,
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    diagnostics::log_path_string(),
                ),
            );
            let state = app.state::<SharedState>();
            let config = Config::load();
            *state.config.lock().map_err(|_| "config lock poisoned")? = config.clone();
            let app_handle = app.handle();
            if let Err(error) = register_hotkey(app_handle, &state, &config.hotkey) {
                // A collision should not prevent the tray/settings UI from opening;
                // the user can choose a different shortcut from Settings.
                eprintln!("global shortcut unavailable: {error}");
            }
            create_tray(app)?;
            if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
                disable_window_transitions(&overlay);
            }
            if let Some(toast) = app.get_webview_window("toast") {
                disable_window_transitions(&toast);
            }
            warm_standby_pin(app_handle, 0);
            // Model loading is expensive but does not need the UI thread.
            // Starting it in the background removes the first-use OCR pause.
            let ocr = state.ocr.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = ocr.warm_up() {
                    eprintln!("OCR model warm-up failed: {error}");
                }
            });
            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building PinShot")
        .run(|_app, event| {
            // Closing the last screenshot/settings window must keep the tray alive.
            // app.exit(0) from the tray still exits explicitly.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let state = app.state::<SharedState>();
    let history_lock = state.history.lock().ok();
    let latest_item = history_lock.as_ref().and_then(|h| h.first().map(|r| r.item.clone()));
    let count = history_lock.as_ref().map(|h| h.len()).unwrap_or(0);

    let (pin_text, has_history) = if let Some(ref item) = latest_item {
        (format!("贴出最近截图 ({}×{})", item.width, item.height), true)
    } else {
        ("贴出最近截图 (无)".to_string(), false)
    };

    let shelf_text = if count > 0 {
        format!("查看历史截图 ({count}/3)...")
    } else {
        "查看历史截图...".to_string()
    };

    let history_pin = MenuItem::with_id(app, "history_pin", &pin_text, has_history, None::<&str>)?;
    let history_shelf = MenuItem::with_id(app, "history_shelf", &shelf_text, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &history_pin,
            &history_shelf,
            &sep,
            &settings,
            &exit,
        ],
    )
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = build_tray_menu(app.handle())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("icon".into()))?;
    TrayIconBuilder::with_id("pinshot-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "history_pin" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<SharedState>();
                    let _ = restore_history_as_pin(app.clone(), state, None);
                });
            }
            "history_shelf" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = show_history_shelf(&app);
                });
            }
            "settings" => {
                queue_settings(app);
            }
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                queue_capture(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn update_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id("pinshot-tray") {
        let menu = build_tray_menu(app)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn notify_history_updated<R: Runtime>(app: &AppHandle<R>) {
    if let Some(history_win) = app.get_webview_window("history") {
        if history_win.is_visible().unwrap_or(false) {
            let _ = history_win.emit("history-updated", ());
        }
    }
    if let Some(settings_win) = app.get_webview_window("settings") {
        if settings_win.is_visible().unwrap_or(false) {
            let _ = settings_win.emit("history-updated", ());
        }
    }
}

fn show_history_shelf<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window("history") {
        let _ = window.show();
        let _ = window.set_focus();
        let win = window.clone();
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let _ = win.emit("history-updated", ());
        });
        return Ok(window);
    }
    let screen = utils::get_virtual_screen_bounds();
    let card_width = 380.0;
    let card_height = (screen.height as f64 * 0.82).min(760.0).max(480.0);
    let pad = 16.0;
    let window_width = card_width + pad * 2.0;
    let window_height = card_height + pad * 2.0;
    let x = (screen.x + screen.width) as f64 - window_width - 16.0;
    let y = screen.y as f64 + ((screen.height as f64 - window_height) / 2.0);

    let window = WebviewWindowBuilder::new(
        app,
        "history",
        WebviewUrl::App("index.html#/history".into()),
    )
    .title("PinShot 截图历史")
    .inner_size(window_width, window_height)
    .min_inner_size(320.0 + pad * 2.0, 420.0 + pad * 2.0)
    .position(x, y)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(true)
    .build()?;

    disable_window_transitions(&window);
    let _ = window.set_focus();
    Ok(window)
}

// WebView2 creation must not block a Windows event callback.
fn queue_capture<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = start_capture(&app, &app.state::<SharedState>()) {
            eprintln!("capture failed: {error}");
        }
    });
}

fn queue_settings<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = show_settings(&app) {
            eprintln!("settings failed: {error}");
        }
    });
}

fn register_hotkey<R: Runtime>(
    app: &AppHandle<R>,
    state: &SharedState,
    binding: &HotkeyBinding,
) -> Result<(), String> {
    if !binding.valid() {
        return Err("无效的快捷键".into());
    }
    let shortcut = Shortcut::try_from(binding.accelerator().as_str()).map_err(|e| e.to_string())?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| e.to_string())?;
    *state.hotkey.lock().map_err(|_| "hotkey lock poisoned")? = Some(shortcut);
    Ok(())
}

fn show_settings<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show()?;
        window.set_focus()?;
        return Ok(window);
    }
    WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html#/settings".into()),
    )
    .title("PinShot 设置")
    .inner_size(620.0, 560.0)
    .min_inner_size(560.0, 500.0)
    .resizable(true)
    .visible(true)
    .center()
    .build()
}

#[tauri::command]
fn get_history_items(
    state: State<'_, SharedState>,
) -> Result<Vec<HistoryItem>, String> {
    let history_lock = state.history.lock().map_err(|_| "history lock poisoned")?;
    Ok(history_lock.iter().map(|r| r.item.clone()).collect())
}

#[tauri::command]
fn get_history_item(
    state: State<'_, SharedState>,
    id: Option<String>,
) -> Result<Option<HistoryItem>, String> {
    let history_lock = state.history.lock().map_err(|_| "history lock poisoned")?;
    if let Some(ref target_id) = id {
        Ok(history_lock.iter().find(|r| &r.item.id == target_id).map(|r| r.item.clone()))
    } else {
        Ok(history_lock.first().map(|r| r.item.clone()))
    }
}

#[tauri::command]
fn get_history_pixels(
    state: State<'_, SharedState>,
    id: Option<String>,
) -> Result<Response, String> {
    let history_lock = state.history.lock().map_err(|_| "history lock poisoned")?;
    let record = if let Some(ref target_id) = id {
        history_lock.iter().find(|r| &r.item.id == target_id)
    } else {
        history_lock.first()
    }.ok_or_else(|| "暂无历史截图".to_string())?;
    Ok(Response::new(record.pixels.clone()))
}

#[tauri::command(async)]
fn restore_history_as_pin(
    app: AppHandle,
    state: State<'_, SharedState>,
    id: Option<String>,
) -> Result<String, String> {
    let history_lock = state.history.lock().map_err(|_| "history lock poisoned")?;
    let record = if let Some(ref target_id) = id {
        history_lock.iter().find(|r| &r.item.id == target_id)
    } else {
        history_lock.first()
    }.ok_or_else(|| "暂无历史截图记录".to_string())?;

    let (pin_id, is_prewarmed) = {
        let mut standby = state.standby_pin.lock().map_err(|_| "standby lock poisoned")?;
        if let Some(standby_id) = standby.take() {
            (standby_id, true)
        } else {
            (NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string(), false)
        }
    };
    let data = PinData {
        id: pin_id.clone(),
        pixels: record.pixels.clone(),
        width: record.item.width,
        height: record.item.height,
        x: record.item.x,
        y: record.item.y,
        always_on_top: true,
        click_through: false,
        ghost_opacity: 0.70,
    };
    drop(history_lock);
    state
        .pins
        .lock()
        .map_err(|_| "pins lock poisoned")?
        .insert(pin_id.clone(), data.clone());

    let label = pin_label(&pin_id);
    if is_prewarmed {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(data.x, data.y)));
            let _ = win.set_size(Size::Physical(PhysicalSize::new(
                data.width.max(32) as u32,
                data.height.max(32) as u32,
            )));
            let _ = win.set_always_on_top(data.always_on_top);
            let _ = win.emit(&format!("pin-init-{}", pin_id), ());
        }
        warm_standby_pin(&app, 1500);
    } else {
        create_pin_window(&app, &data)?;
    }

    if let Some(drawer) = app.get_webview_window("history") {
        let _ = drawer.hide();
    }
    Ok(pin_id)
}

#[tauri::command(async)]
fn copy_history_to_clipboard(
    app: AppHandle,
    state: State<'_, SharedState>,
    id: Option<String>,
) -> Result<(), String> {
    let history_lock = state.history.lock().map_err(|_| "history lock poisoned")?;
    let record = if let Some(ref target_id) = id {
        history_lock.iter().find(|r| &r.item.id == target_id)
    } else {
        history_lock.first()
    }.ok_or_else(|| "暂无历史截图记录".to_string())?;

    let record = record.clone();
    drop(history_lock);

    let hwnd = app
        .get_webview_window(OVERLAY_LABEL)
        .or_else(|| app.get_webview_window("history"))
        .and_then(|w| w.hwnd().ok())
        .unwrap_or(HWND::default());

    clipboard::copy_rgba_to_clipboard(hwnd, &record.pixels, record.item.width, record.item.height)
        .map_err(|e| format!("复制失败: {e}"))?;

    Ok(())
}

#[tauri::command(async)]
fn save_history_to_file(
    app: AppHandle,
    state: State<'_, SharedState>,
    id: Option<String>,
) -> Result<String, String> {
    let history_lock = state.history.lock().map_err(|_| "history lock poisoned")?;
    let record = if let Some(ref target_id) = id {
        history_lock.iter().find(|r| &r.item.id == target_id)
    } else {
        history_lock.first()
    }.ok_or_else(|| "暂无历史截图记录".to_string())?;

    let record = record.clone();
    drop(history_lock);

    let config = state
        .config
        .lock()
        .map_err(|_| "config lock poisoned")?
        .clone();
    let path = save_rgba(
        &record.pixels,
        record.item.width,
        record.item.height,
        &config.save_directory_path(),
    )?;
    let path_str = path.to_string_lossy().into_owned();
    show_save_toast(&app, &path_str, "历史截图已保存");
    Ok(path_str)
}

#[tauri::command]
fn delete_history_item(
    app: AppHandle,
    state: State<'_, SharedState>,
    id: String,
) -> Result<(), String> {
    let mut history_lock = state.history.lock().map_err(|_| "history lock poisoned")?;
    history_lock.retain(|r| r.item.id != id);
    drop(history_lock);
    let _ = update_tray_menu(&app);
    notify_history_updated(&app);
    Ok(())
}

#[tauri::command]
fn clear_history(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    state.history.lock().map_err(|_| "history lock poisoned")?.clear();
    let _ = update_tray_menu(&app);
    notify_history_updated(&app);
    Ok(())
}

#[tauri::command]
async fn show_history_shelf_from_ui(app: AppHandle) -> Result<(), String> {
    diagnostics::log("INFO", "history.window", "open requested from settings");
    // WebView2 creation deadlocks inside a synchronous Windows IPC callback.
    // Await a worker so the event loop stays free and errors reach the caller.
    let result = tauri::async_runtime::spawn_blocking(move || {
        diagnostics::log("INFO", "history.window", "opening on worker");
        show_history_shelf(&app).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("history window task failed: {e}"))
    .and_then(|result| result);

    match &result {
        Ok(()) => diagnostics::log("INFO", "history.window", "open completed"),
        Err(error) => diagnostics::log("ERROR", "history.window", format!("open failed: {error}")),
    }
    result
}

#[tauri::command]
fn hide_history_shelf(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("history") {
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let _ = window.hide();
        });
    }
    Ok(())
}

fn pin_label(id: &str) -> String {
    format!("pin-{id}")
}

fn start_capture<R: Runtime>(app: &AppHandle<R>, state: &SharedState) -> Result<(), String> {
    let mut active = state.capture.lock().map_err(|_| "capture lock poisoned")?;
    if active.is_some() {
        return Ok(());
    }
    if let Some(toast) = app.get_webview_window("toast") {
        hide_toast_window(&toast);
    }
    let capture = ScreenCapture::full_screen().map_err(|e| format!("截图失败: {e}"))?;
    let detected_windows = window_detector::detect_visible_windows(&capture.screen);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let session = CaptureSession {
        id: id.clone(),
        screen: capture.screen.clone(),
        pixels: capture.pixels,
        windows: detected_windows,
    };
    let screen = session.screen.clone();
    *active = Some(session);
    drop(active);
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "截图浮层尚未初始化".to_string())?;
    let prepare = window
        .set_position(Position::Physical(PhysicalPosition::new(
            screen.x, screen.y,
        )))
        .and_then(|_| {
            window.set_size(Size::Physical(PhysicalSize::new(
                screen.width as u32,
                screen.height as u32,
            )))
        })
        .and_then(|_| window.emit("capture-started", id.clone()));
    if let Err(error) = prepare {
        *state.capture.lock().map_err(|_| "capture lock poisoned")? = None;
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
fn get_settings(state: State<'_, SharedState>) -> Result<SettingsDto, String> {
    let config = state
        .config
        .lock()
        .map_err(|_| "config lock poisoned")?
        .clone();
    Ok(SettingsDto {
        hotkey: config.hotkey,
        save_directory: config.save_directory,
        autostart: config.autostart,
        theme: config.theme,
    })
}

#[tauri::command]
fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedState>,
    draft: SettingsDraft,
) -> Result<SettingsDto, String> {
    if !draft.hotkey.valid() {
        return Err("快捷键必须包含至少一个修饰键,并且按键有效".into());
    }
    validate_save_directory(&draft.save_directory)?;
    let old = state
        .config
        .lock()
        .map_err(|_| "config lock poisoned")?
        .clone();
    let old_shortcut = *state
        .hotkey
        .lock()
        .map_err(|_| "hotkey lock poisoned")?;
    let new_shortcut =
        Shortcut::try_from(draft.hotkey.accelerator().as_str()).map_err(|e| e.to_string())?;
    let changed = old_shortcut.as_ref() != Some(&new_shortcut);
    if changed {
        app.global_shortcut()
            .register(new_shortcut)
            .map_err(|_| "快捷键已被其他应用占用".to_string())?;
    }
    let mut next = Config {
        hotkey: draft.hotkey,
        save_directory: draft.save_directory,
        autostart: draft.autostart,
        theme: draft.theme,
    };
    next.set_autostart(next.autostart);
    if let Err(error) = next.save() {
        if changed {
            let _ = app.global_shortcut().unregister(new_shortcut);
        }
        next.set_autostart(old.autostart);
        return Err(format!("设置保存失败: {error}"));
    }
    if changed {
        if let Some(previous) = old_shortcut {
            let _ = app.global_shortcut().unregister(previous);
        }
        *state.hotkey.lock().map_err(|_| "hotkey lock poisoned")? = Some(new_shortcut);
    }
    *state.config.lock().map_err(|_| "config lock poisoned")? = next.clone();
    let _ = app.emit("theme-changed", next.theme.clone());
    Ok(SettingsDto {
        hotkey: next.hotkey,
        save_directory: next.save_directory,
        autostart: next.autostart,
        theme: next.theme,
    })
}

#[tauri::command]
async fn pick_save_directory<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("选择截图保存目录")
        .blocking_pick_folder();
    Ok(picked.map(|path| path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::decode_percent_header;

    #[test]
    fn decodes_unicode_recording_paths() {
        assert_eq!(
            decode_percent_header("%E6%B5%8B%E8%AF%95%5C%E5%BD%95%E5%B1%8F.webm")
                .unwrap(),
            "测试\\录屏.webm"
        );
    }
}

#[tauri::command]
async fn start_capture_from_ui<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    start_capture(&app, &state)
}

#[tauri::command]
fn get_active_capture_id(state: State<'_, SharedState>) -> Result<Option<String>, String> {
    Ok(state
        .capture
        .lock()
        .map_err(|_| "capture lock poisoned")?
        .as_ref()
        .map(|session| session.id.clone()))
}

/// Returns the durable diagnostics path so users can attach the file after an
/// intermittent hang or crash.  This command intentionally has no UI side
/// effects; diagnostics must remain available even when the overlay is not.
#[tauri::command]
fn get_diagnostic_log_path() -> String {
    diagnostics::log_path_string()
}

#[tauri::command]
fn write_diagnostic_log(
    level: String,
    source: String,
    message: String,
    stack: Option<String>,
) -> Result<(), String> {
    let message = match stack.filter(|stack| !stack.trim().is_empty()) {
        Some(stack) => format!("{message}; stack={stack}"),
        None => message,
    };
    diagnostics::log(&level, &source, message);
    Ok(())
}

#[tauri::command]
fn get_capture_manifest(
    state: State<'_, SharedState>,
    session_id: String,
) -> Result<CaptureManifest, String> {
    let capture = state.capture.lock().map_err(|_| "capture lock poisoned")?;
    let session = capture
        .as_ref()
        .filter(|s| s.id == session_id)
        .ok_or_else(|| "截图会话已失效".to_string())?;
    Ok(CaptureManifest {
        session_id: session.id.clone(),
        screen_x: session.screen.x,
        screen_y: session.screen.y,
        width: session.screen.width,
        height: session.screen.height,
        pixel_format: "rgba8",
        windows: session.windows.clone(),
    })
}

#[tauri::command]
fn get_capture_pixels(
    state: State<'_, SharedState>,
    session_id: String,
) -> Result<Response, String> {
    let capture = state.capture.lock().map_err(|_| "capture lock poisoned")?;
    let session = capture
        .as_ref()
        .filter(|s| s.id == session_id)
        .ok_or_else(|| "截图会话已失效".to_string())?;
    Ok(Response::new(session.pixels.clone()))
}

#[tauri::command]
fn overlay_ready(app: AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<SharedState>();
    let matches = state
        .capture
        .lock()
        .map_err(|_| "capture lock poisoned")?
        .as_ref()
        .is_some_and(|session| session.id == session_id);
    if !matches {
        return Err("截图会话已失效".into());
    }
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "选区窗口不存在".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSelection {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[tauri::command]
fn cancel_capture(
    app: AppHandle,
    state: State<'_, SharedState>,
    session_id: String,
    selection: Option<CancelSelection>,
) -> Result<(), String> {
    let mut capture_lock = state.capture.lock().map_err(|_| "capture lock poisoned")?;
    let session = capture_lock.take();
    drop(capture_lock);

    if let Some(session) = session {
        if session.id == session_id {
            if let Some(sel) = selection {
                if sel.width >= 32 && sel.height >= 32 {
                    if let Ok(cropped) = crop_rgba(
                        &session.pixels,
                        session.screen.width,
                        session.screen.height,
                        sel.x,
                        sel.y,
                        sel.width,
                        sel.height,
                    ) {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let item = HistoryItem {
                            id: format!("hist-{}", now),
                            width: sel.width,
                            height: sel.height,
                            x: session.screen.x + sel.x,
                            y: session.screen.y + sel.y,
                            timestamp: now,
                            time_str: "未完成选区".to_string(),
                            action: "cancel".to_string(),
                            path: None,
                        };
                        if let Ok(mut hist) = state.history.lock() {
                            hist.insert(0, HistoryRecord {
                                item,
                                pixels: cropped,
                            });
                            if hist.len() > 3 {
                                hist.truncate(3);
                            }
                        }
                        let _ = update_tray_menu(&app);
                        notify_history_updated(&app);
                    }
                }
            }
        }
    }

    if let Ok(mut lc) = state.long_capture.lock() {
        *lc = None;
    }

    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        if let Ok(hwnd) = window.hwnd() {
            let _ = capture::restore_overlay_region(hwnd);
        }
        let _ = window.hide();
        let _ = window.emit("capture-ended", ());
    }
    Ok(())
}

fn parse_header(request: &Request<'_>, key: &str) -> Result<String, String> {
    request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少请求头 {key}"))
}

fn parse_i32_header(request: &Request<'_>, key: &str) -> Result<i32, String> {
    parse_header(request, key)?
        .parse()
        .map_err(|_| format!("无效的请求头 {key}"))
}

fn decode_percent_header(value: &str) -> Result<String, String> {
    fn hex_digit(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("保存路径编码无效".into());
            }
            let high = hex_digit(bytes[index + 1]).ok_or_else(|| "保存路径编码无效".to_string())?;
            let low = hex_digit(bytes[index + 2]).ok_or_else(|| "保存路径编码无效".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "保存路径编码不是有效文本".into())
}

#[tauri::command(async)]
fn complete_capture<R: Runtime>(
    request: Request<'_>,
    app: AppHandle<R>,
    state: State<'_, SharedState>,
) -> Result<ActionResult, String> {
    let session_id = parse_header(&request, "x-pinshot-session")?;
    let action = parse_header(&request, "x-pinshot-action")?;
    let x = parse_i32_header(&request, "x-pinshot-x")?;
    let y = parse_i32_header(&request, "x-pinshot-y")?;
    let width = parse_i32_header(&request, "x-pinshot-width")?;
    let height = parse_i32_header(&request, "x-pinshot-height")?;
    if width <= 0 || height <= 0 {
        return Err("选区尺寸无效".into());
    }
    let InvokeBody::Raw(raw) = request.body() else {
        return Err("截图必须通过二进制上传".into());
    };
    let pixels = raw.clone();
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| "图像尺寸过大".to_string())?;
    if pixels.len() != expected {
        return Err("截图像素尺寸不匹配".into());
    }
    let mut capture_lock = state.capture.lock().map_err(|_| "capture lock poisoned")?;
    let session = capture_lock
        .as_ref()
        .filter(|s| s.id == session_id)
        .ok_or_else(|| "截图会话已失效".to_string())?;
    if width > 32768 || height > 32768 {
        return Err("图像尺寸超出上限".into());
    }
    let overlay = app.get_webview_window(OVERLAY_LABEL);
    let hwnd = overlay
        .as_ref()
        .and_then(|window| window.hwnd().ok())
        .unwrap_or(HWND::default());
    let should_close = matches!(action.as_str(), "save" | "copy" | "ocr");
    let result = match action.as_str() {
        "save" => {
            let config = state
                .config
                .lock()
                .map_err(|_| "config lock poisoned")?
                .clone();
            let path = save_rgba(&pixels, width, height, &config.save_directory_path())?;
            let path_str = path.to_string_lossy().into_owned();
            show_save_toast(&app, &path_str, "截图已保存");
            ActionResult {
                action: action.clone(),
                path: Some(path_str),
                pin_id: None,
            }
        }
        "copy" => {
            clipboard::copy_rgba_to_clipboard(hwnd, &pixels, width, height)
                .map_err(|e| format!("复制失败: {e}"))?;
            ActionResult {
                action: action.clone(),
                path: None,
                pin_id: None,
            }
        }
        "ocr" => {
            let ocr_res = state
                .ocr
                .recognize(pixels.clone(), width as u32, height as u32)
                .map_err(|e| format!("OCR 识别失败: {e}"))?;
            let text = ocr_res.full_text;
            if text.trim().is_empty() {
                show_toast_window(
                    &app,
                    ToastPayload {
                        kind: "info".to_string(),
                        path: None,
                        message: "选区内未识别到任何文字".to_string(),
                        subtext: None,
                        duration: Some(2500),
                    },
                );
            } else {
                clipboard::copy_text_to_clipboard(hwnd, &text)
                    .map_err(|e| format!("复制文字失败: {e}"))?;
            }
            ActionResult {
                action: action.clone(),
                path: Some(text),
                pin_id: None,
            }
        }
        "pin" => {
            let (id, is_prewarmed) = {
                let mut standby = state.standby_pin.lock().map_err(|_| "standby lock poisoned")?;
                if let Some(standby_id) = standby.take() {
                    (standby_id, true)
                } else {
                    (NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string(), false)
                }
            };
            let data = PinData {
                id: id.clone(),
                pixels: pixels.clone(),
                width,
                height,
                x: session.screen.x + x,
                y: session.screen.y + y,
                always_on_top: true,
                click_through: false,
                ghost_opacity: 0.70,
            };
            state
                .pins
                .lock()
                .map_err(|_| "pins lock poisoned")?
                .insert(id.clone(), data.clone());

            let label = pin_label(&id);
            if is_prewarmed {
                if let Some(win) = app.get_webview_window(&label) {
                    let _ = win.set_position(Position::Physical(PhysicalPosition::new(data.x, data.y)));
                    let _ = win.set_size(Size::Physical(PhysicalSize::new(
                        data.width.max(32) as u32,
                        data.height.max(32) as u32,
                    )));
                    let _ = win.set_always_on_top(data.always_on_top);
                    let _ = win.emit(&format!("pin-init-{}", id), ());
                }
                warm_standby_pin(&app, 1500);
            } else {
                if let Err(error) = create_pin_window(&app, &data) {
                    if let Ok(mut pins) = state.pins.lock() {
                        pins.remove(&id);
                    }
                    return Err(error);
                }
            }
            ActionResult {
                action: action.clone(),
                path: None,
                pin_id: Some(id),
            }
        }
        _ => return Err("未知截图动作".into()),
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let hist_item = HistoryItem {
        id: format!("hist-{}", now),
        width,
        height,
        x: session.screen.x + x,
        y: session.screen.y + y,
        timestamp: now,
        time_str: match action.as_str() {
            "save" => "保存".to_string(),
            "copy" => "复制".to_string(),
            "pin" => "贴图".to_string(),
            "ocr" => "文字识别".to_string(),
            _ => action.clone(),
        },
        action: action.clone(),
        path: match action.as_str() {
            "save" => result.path.clone(),
            _ => None,
        },
    };
    if let Ok(mut hist) = state.history.lock() {
        hist.insert(0, HistoryRecord {
            item: hist_item,
            pixels: pixels.clone(),
        });
        if hist.len() > 3 {
            hist.truncate(3);
        }
    }
    let _ = update_tray_menu(&app);
    notify_history_updated(&app);

    if should_close {
        *capture_lock = None;
        drop(capture_lock);
        if let Some(window) = overlay {
            let _ = window.hide();
            let _ = window.emit("capture-ended", ());
        }
    }
    Ok(result)
}

fn warm_standby_pin<R: Runtime>(app: &AppHandle<R>, delay_ms: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        let state = app.state::<SharedState>();
        {
            if let Ok(standby) = state.standby_pin.lock() {
                if standby.is_some() {
                    return;
                }
            }
        }
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
        let label = pin_label(&id);
        if let Ok(window) = WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::App(format!("index.html#/pin/{}", id).into()),
        )
        .title("PinShot Pin")
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        .visible(false)
        .inner_size(100.0, 100.0)
        .min_inner_size(32.0, 32.0)
        .build()
        {
            disable_window_transitions(&window);
            let _ = window.set_position(Position::Physical(PhysicalPosition::new(-30000, -30000)));
            if let Ok(mut standby) = state.standby_pin.lock() {
                *standby = Some(id);
            }
        }
    });
}

fn disable_window_transitions<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
        unsafe {
            let disable: windows::core::BOOL = true.into();
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disable as *const _ as *const _,
                std::mem::size_of::<windows::core::BOOL>() as u32,
            );
        }
    }
}

fn create_pin_window<R: Runtime>(app: &AppHandle<R>, data: &PinData) -> Result<(), String> {
    let label = pin_label(&data.id);
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html#/pin/{}", data.id).into()),
    )
    .title("PinShot Pin")
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .always_on_top(data.always_on_top)
    .skip_taskbar(true)
    .resizable(true)
    .focused(false)
    .visible(false)
    .inner_size(data.width.max(32) as f64, data.height.max(32) as f64)
    .min_inner_size(32.0, 32.0)
    .build()
    .map_err(|e| e.to_string())?;
    disable_window_transitions(&window);
    window
        .set_position(Position::Physical(PhysicalPosition::new(data.x, data.y)))
        .map_err(|e| e.to_string())?;
    window
        .set_size(Size::Physical(PhysicalSize::new(
            data.width.max(32) as u32,
            data.height.max(32) as u32,
        )))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInitData {
    pub pin_id: String,
    pub width: i32,
    pub height: i32,
    pub always_on_top: bool,
    pub click_through: bool,
    pub pixels: Vec<u8>,
}

#[tauri::command]
fn get_pin_init_data(
    state: State<'_, SharedState>,
    pin_id: String,
) -> Result<PinInitData, String> {
    let pins = state.pins.lock().map_err(|_| "pins lock poisoned")?;
    let pin = pins.get(&pin_id).ok_or_else(|| "钉图正在准备中".to_string())?;
    Ok(PinInitData {
        pin_id,
        width: pin.width,
        height: pin.height,
        always_on_top: pin.always_on_top,
        click_through: pin.click_through,
        pixels: pin.pixels.clone(),
    })
}

#[tauri::command]
fn get_pin_manifest(state: State<'_, SharedState>, pin_id: String) -> Result<PinManifest, String> {
    let pins = state.pins.lock().map_err(|_| "pins lock poisoned")?;
    let pin = pins.get(&pin_id).ok_or_else(|| "钉图不存在".to_string())?;
    Ok(PinManifest {
        pin_id,
        width: pin.width,
        height: pin.height,
        always_on_top: pin.always_on_top,
        click_through: pin.click_through,
    })
}

#[tauri::command]
fn get_pin_pixels(state: State<'_, SharedState>, pin_id: String) -> Result<Response, String> {
    let pins = state.pins.lock().map_err(|_| "pins lock poisoned")?;
    Ok(Response::new(
        pins.get(&pin_id)
            .ok_or_else(|| "钉图不存在".to_string())?
            .pixels
            .clone(),
    ))
}

#[tauri::command]
fn pin_ready(app: AppHandle, pin_id: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&pin_label(&pin_id))
        .ok_or_else(|| "钉图窗口不存在".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    // Seamless handoff: overlay is hidden only AFTER the pin window is visible and painted
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
        let _ = overlay.emit("capture-ended", ());
    }
    let state = app.state::<SharedState>();
    if let Ok(mut capture) = state.capture.lock() {
        *capture = None;
    }
    Ok(())
}

#[tauri::command(async)]
fn pin_action<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedState>,
    request: PinAction,
) -> Result<ActionResult, String> {
    // Update shared state briefly, then release it before window calls or I/O.
    let pin = {
        let mut pins = state.pins.lock().map_err(|_| "pins lock poisoned")?;
        let pin = pins.get_mut(&request.pin_id).ok_or_else(|| "钉图不存在".to_string())?;
        match request.action.as_str() {
            "toggleTopmost" => pin.always_on_top = !pin.always_on_top,
            "toggleClickThrough" => {
                pin.click_through = !pin.click_through;
                pin.ghost_opacity = request.opacity.unwrap_or(0.70);
            }
            "cancelClickThrough" | "close" => pin.click_through = false,
            "setGhostOpacity" => pin.ghost_opacity = request.opacity.unwrap_or(0.70),
            "copy" | "save" | "copyText" => {}
            _ => return Err("未知钉图动作".into()),
        }
        let snapshot = pin.clone();
        if request.action == "close" {
            pins.remove(&request.pin_id);
        }
        snapshot
    };
    let window = app.get_webview_window(&pin_label(&request.pin_id));
    let hwnd = window
        .as_ref()
        .and_then(|w| w.hwnd().ok())
        .unwrap_or(HWND::default());
    match request.action.as_str() {
        "copy" => {
            clipboard::copy_rgba_to_clipboard(hwnd, &pin.pixels, pin.width, pin.height)
                .map_err(|e| format!("复制失败: {e}"))?;
        }
        "save" => {
            let config = state
                .config
                .lock()
                .map_err(|_| "config lock poisoned")?
                .clone();
            let path = save_rgba(
                &pin.pixels,
                pin.width,
                pin.height,
                &config.save_directory_path(),
            )?;
            let path_str = path.to_string_lossy().into_owned();
            show_save_toast(&app, &path_str, "截图已保存");
            return Ok(ActionResult {
                action: request.action,
                path: Some(path_str),
                pin_id: Some(request.pin_id),
            });
        }
        "toggleTopmost" => {
            if let Some(window) = window {
                window
                    .set_always_on_top(pin.always_on_top)
                    .map_err(|e| e.to_string())?;
            }
        }
        "toggleClickThrough" => {
            let is_enabled = pin.click_through;
            let pin_id = request.pin_id.clone();
            let app_handle = app.clone();
            if let Some(w) = &window {
                let _ = w.emit(&format!("pin-click-through-{}", pin_id), is_enabled);
                let scale_factor = w.scale_factor().unwrap_or(1.0);
                if let Ok(hwnd) = w.hwnd() {
                    apply_click_through_mode(app_handle, pin_id, hwnd, is_enabled, scale_factor);
                }
            }
        }
        "cancelClickThrough" => {
            let pin_id = request.pin_id.clone();
            let app_handle = app.clone();
            if let Some(w) = &window {
                let _ = w.emit(&format!("pin-click-through-{}", pin_id), false);
                let scale_factor = w.scale_factor().unwrap_or(1.0);
                if let Ok(hwnd) = w.hwnd() {
                    apply_click_through_mode(app_handle, pin_id, hwnd, false, scale_factor);
                }
            }
        }
        "setGhostOpacity" => {}
        "copyText" => {
            let ocr_res = state
                .ocr
                .recognize(pin.pixels.clone(), pin.width as u32, pin.height as u32)
                .map_err(|e| format!("OCR 识别失败: {e}"))?;
            let text = ocr_res.full_text;
            if text.trim().is_empty() {
                show_toast_window(
                    &app,
                    ToastPayload {
                        kind: "info".to_string(),
                        path: None,
                        message: "贴图中未识别到任何文字".to_string(),
                        subtext: None,
                        duration: Some(2500),
                    },
                );
            } else {
                clipboard::copy_text_to_clipboard(hwnd, &text)
                    .map_err(|e| format!("复制文字失败: {e}"))?;
            }
            return Ok(ActionResult {
                action: request.action,
                path: Some(text),
                pin_id: Some(request.pin_id),
            });
        }
        "close" => {
            if let Some(window) = window {
                tauri::async_runtime::spawn_blocking(move || {
                    std::thread::sleep(std::time::Duration::from_millis(16));
                    let _ = window.close();
                });
            }
        }
        _ => return Err("未知钉图动作".into()),
    }
    Ok(ActionResult {
        action: request.action,
        path: None,
        pin_id: Some(request.pin_id),
    })
}

#[tauri::command]
async fn ocr_pin(
    state: State<'_, SharedState>,
    pin_id: String,
) -> Result<ocr::OcrResponse, String> {
    let (pixels, width, height) = {
        let pins = state.pins.lock().map_err(|_| "pins lock poisoned")?;
        let pin = pins.get(&pin_id).ok_or_else(|| "钉图不存在".to_string())?;
        (pin.pixels.clone(), pin.width as u32, pin.height as u32)
    };
    let ocr = state.ocr.clone();
    tauri::async_runtime::spawn_blocking(move || ocr.recognize(pixels, width, height))
        .await
        .map_err(|e| format!("OCR task failed: {e}"))?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

fn crop_rgba(
    src: &[u8],
    src_width: i32,
    src_height: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<Vec<u8>, String> {
    if width <= 0 || height <= 0 {
        return Err("选区尺寸无效".into());
    }
    if x < 0 || y < 0 || x + width > src_width || y + height > src_height {
        return Err("选区超出图像范围".into());
    }
    let src_stride = src_width as usize * 4;
    let dst_stride = width as usize * 4;
    let mut dst = vec![0u8; width as usize * height as usize * 4];
    for row in 0..height as usize {
        let src_start = (y as usize + row) * src_stride + (x as usize * 4);
        let src_end = src_start + dst_stride;
        let dst_start = row * dst_stride;
        let dst_end = dst_start + dst_stride;
        dst[dst_start..dst_end].copy_from_slice(&src[src_start..src_end]);
    }
    Ok(dst)
}

#[tauri::command]
async fn ocr_capture(
    state: State<'_, SharedState>,
    session_id: String,
    rect: CropRect,
) -> Result<ocr::OcrResponse, String> {
    let cropped = {
        let capture_lock = state.capture.lock().map_err(|_| "capture lock poisoned")?;
        let session = capture_lock
            .as_ref()
            .filter(|s| s.id == session_id)
            .ok_or_else(|| "截图会话已失效".to_string())?;

        crop_rgba(
            &session.pixels,
            session.screen.width,
            session.screen.height,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        )?
    };

    let ocr = state.ocr.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ocr.recognize(cropped, rect.width as u32, rect.height as u32)
    })
    .await
    .map_err(|e| format!("OCR task failed: {e}"))?
}

#[tauri::command(async)]
fn copy_text_to_clipboard_cmd<R: Runtime>(
    _app: AppHandle<R>,
    text: String,
) -> Result<(), String> {
    let hwnd = HWND::default();
    clipboard::copy_text_to_clipboard(hwnd, &text).map_err(|e| format!("复制文字失败: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
fn start_long_capture<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedState>,
    session_id: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<LongCaptureStartResult, String> {
    if width <= 0 || height <= 0 {
        return Err("选区尺寸无效".into());
    }
    // The frame matcher needs enough rows/columns for a reliable overlap.
    // Reject undersized selections explicitly instead of entering a mode that
    // can never append another frame and silently produces a one-frame image.
    if width < 30 || height < 60 {
        return Err("长截图选区至少需要 30×60 像素".into());
    }
    if let Some(toast) = app.get_webview_window("toast") {
        hide_toast_window(&toast);
    }
    let (initial_pixels, screen_x, screen_y, screen_w, screen_h) = {
        let capture_lock = state.capture.lock().map_err(|_| "capture lock poisoned")?;
        let session = capture_lock
            .as_ref()
            .filter(|s| s.id == session_id)
            .ok_or_else(|| "截图会话已失效".to_string())?;

        let sx = session.screen.x + x;
        let sy = session.screen.y + y;
        let cropped = crop_rgba(
            &session.pixels,
            session.screen.width,
            session.screen.height,
            x,
            y,
            width,
            height,
        )?;
        (cropped, sx, sy, session.screen.width, session.screen.height)
    };

    let overlay = app.get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "截图浮层不存在".to_string())?;
    let hwnd = overlay.hwnd().map_err(|e| e.to_string())?;
    capture::punch_overlay_hole(hwnd, x, y, width, height, screen_w, screen_h)?;

    let center_x = screen_x + width / 2;
    let center_y = screen_y + height / 2;

    let stitcher = stitching::Stitcher::new(initial_pixels, width as u32, height as u32)?;
    let preview_url = stitcher.generate_preview_data_url(160);
    let total_height = stitcher.total_height;
    let frame_count = stitcher.frame_count;

    {
        let mut lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
        *lc_lock = Some(LongCaptureSession {
            session_id,
            stitcher,
            screen_x,
            screen_y,
            width: width as u32,
            height: height as u32,
            center_x,
            center_y,
        });
    }

    Ok(LongCaptureStartResult {
        total_height,
        frame_count,
        preview_url,
    })
}

#[tauri::command(async)]
fn long_capture_scroll_step<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, SharedState>,
    clicks: Option<i32>,
) -> Result<stitching::StitchResult, String> {
    // Keep the session locked for the complete scroll/capture operation.
    // This serializes wheel bursts and guarantees that finish/cancel cannot
    // race an in-flight frame.
    let mut lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
    let session = lc_lock.as_mut().ok_or_else(|| "未处于长截图状态".to_string())?;

    let delta = clicks.unwrap_or(-1).clamp(-10, -1) * 120;
    let next_frame = capture::scroll_under_overlay(session.center_x, session.center_y, delta)
        .and_then(|_| {
            std::thread::sleep(std::time::Duration::from_millis(240));
            capture::capture_stable_screen_rect(
                session.screen_x,
                session.screen_y,
                session.width as i32,
                session.height as i32,
            )
        });
    let next_frame = next_frame.map_err(|e| format!("捕获屏幕切片失败: {e}"))?;

    session.stitcher.add_frame_ext(&next_frame, true)
}

#[tauri::command(async)]
fn long_capture_manual_frame<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, SharedState>,
) -> Result<stitching::StitchResult, String> {
    let mut lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
    let session = lc_lock.as_mut().ok_or_else(|| "未处于长截图状态".to_string())?;

    let next_frame = capture::capture_stable_screen_rect(
        session.screen_x,
        session.screen_y,
        session.width as i32,
        session.height as i32,
    );
    let next_frame = next_frame.map_err(|e| format!("捕获屏幕切片失败: {e}"))?;

    session.stitcher.add_frame_ext(&next_frame, false)
}

#[tauri::command]
fn get_long_capture_preview(
    state: State<'_, SharedState>,
    preview_width: Option<u32>,
) -> Result<Option<String>, String> {
    let lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
    let session = lc_lock.as_ref().ok_or_else(|| "未处于长截图状态".to_string())?;
    Ok(session.stitcher.generate_preview_data_url(preview_width.unwrap_or(180)))
}

#[tauri::command]
fn get_long_capture_info(state: State<'_, SharedState>) -> Result<LongCaptureInfo, String> {
    let lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
    let session = lc_lock.as_ref().ok_or_else(|| "未处于长截图状态".to_string())?;
    Ok(LongCaptureInfo {
        width: session.stitcher.width,
        height: session.stitcher.total_height,
    })
}

#[tauri::command]
fn get_long_capture_pixels(state: State<'_, SharedState>) -> Result<Response, String> {
    let lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
    let session = lc_lock.as_ref().ok_or_else(|| "未处于长截图状态".to_string())?;
    Ok(Response::new(session.stitcher.accumulated_pixels.clone()))
}

#[tauri::command(async)]
fn finish_long_capture<R: Runtime>(
    request: Request<'_>,
    app: AppHandle<R>,
    state: State<'_, SharedState>,
) -> Result<ActionResult, String> {
    let action = parse_header(&request, "x-pinshot-action")?;
    let width = parse_i32_header(&request, "x-pinshot-width")?;
    let height = parse_i32_header(&request, "x-pinshot-height")?;
    if width <= 0 || height <= 0 || width > 32768 || height > 32768 {
        return Err("长截图尺寸无效或超出上限".into());
    }
    let InvokeBody::Raw(raw) = request.body() else {
        return Err("长截图必须通过二进制上传".into());
    };
    let pixels = raw.clone();
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| "图像尺寸过大".to_string())?;
    if pixels.len() != expected {
        return Err("长截图像素尺寸不匹配".into());
    }

    let lc_session = {
        let mut lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
        lc_lock.take().ok_or_else(|| "长截图会话不存在".to_string())?
    };

    // Keep the session alive locally while the export runs. Any export error
    // puts it back below so the user can retry without losing the stitcher.
    let overlay = app.get_webview_window(OVERLAY_LABEL);
    let hwnd = overlay
        .as_ref()
        .and_then(|window| window.hwnd().ok())
        .unwrap_or(HWND::default());

    let result: Result<ActionResult, String> = (|| {
        Ok(match action.as_str() {
            "save" => {
                let config = state
                    .config
                    .lock()
                    .map_err(|_| "config lock poisoned")?
                    .clone();
                let path = save_rgba(&pixels, width, height, &config.save_directory_path())?;
                let path_str = path.to_string_lossy().into_owned();
                show_save_toast(&app, &path_str, "长截图已保存");
                ActionResult {
                    action: action.clone(),
                    path: Some(path_str),
                    pin_id: None,
                }
            }
            "copy" => {
                clipboard::copy_rgba_to_clipboard(hwnd, &pixels, width, height)
                    .map_err(|e| format!("复制失败: {e}"))?;
                ActionResult {
                    action: action.clone(),
                    path: None,
                    pin_id: None,
                }
            }
            "ocr" => {
                let ocr_res = state
                    .ocr
                    .recognize(pixels.clone(), width as u32, height as u32)
                    .map_err(|e| format!("OCR 识别失败: {e}"))?;
                let text = ocr_res.full_text;
                if text.trim().is_empty() {
                    show_toast_window(
                        &app,
                        ToastPayload {
                            kind: "info".to_string(),
                            path: None,
                            message: "长截图内未识别到文字".to_string(),
                            subtext: None,
                            duration: Some(2500),
                        },
                    );
                } else {
                    clipboard::copy_text_to_clipboard(hwnd, &text)
                        .map_err(|e| format!("复制文字失败: {e}"))?;
                }
                ActionResult {
                    action: action.clone(),
                    path: Some(text),
                    pin_id: None,
                }
            }
            _ => return Err("未知截图动作".into()),
        })
    })();

    let result = match result {
        Ok(result) => result,
        Err(error) => {
            // An export failure is recoverable. Put the stitcher back so the
            // user can retry, and leave overlay restoration to the eventual
            // successful export or explicit cancel action.
            if let Ok(mut lc_lock) = state.long_capture.lock() {
                if lc_lock.is_none() {
                    *lc_lock = Some(lc_session);
                }
            }
            return Err(error);
        }
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let hist_item = HistoryItem {
        id: format!("hist-{}", now),
        width,
        height,
        x: lc_session.screen_x,
        y: lc_session.screen_y,
        timestamp: now,
        time_str: match action.as_str() {
            "save" => "长截图保存".to_string(),
            "copy" => "长截图复制".to_string(),
            "ocr" => "长截图提取".to_string(),
            _ => action.clone(),
        },
        action: action.clone(),
        path: match action.as_str() {
            "save" => result.path.clone(),
            _ => None,
        },
    };
    if let Ok(mut hist) = state.history.lock() {
        hist.insert(0, HistoryRecord {
            item: hist_item,
            pixels: pixels.clone(),
        });
        if hist.len() > 3 {
            hist.truncate(3);
        }
    }
    let _ = update_tray_menu(&app);
    notify_history_updated(&app);

    // Unlike a normal pin operation, the long-capture stitcher has been
    // consumed and cannot return to an editable overlay. Always close the
    // session so "pin" cannot leave a transparent input-blocking window.
    if let Ok(mut capture_lock) = state.capture.lock() {
        *capture_lock = None;
    }
    if let Some(window) = overlay {
        let _ = capture::restore_overlay_region(hwnd);
        let _ = window.hide();
        let _ = window.emit("capture-ended", ());
    }

    Ok(result)
}

#[tauri::command]
fn cancel_long_capture<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let mut lc_lock = state.long_capture.lock().map_err(|_| "long_capture lock poisoned")?;
    *lc_lock = None;
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        if let Ok(hwnd) = window.hwnd() {
            let _ = capture::restore_overlay_region(hwnd);
        }
    }
    Ok(())
}

fn apply_click_through_mode<R: Runtime>(
    app: AppHandle<R>,
    pin_id: String,
    hwnd: windows::Win32::Foundation::HWND,
    enabled: bool,
    scale_factor: f64,
) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
            SetWindowPos, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_FRAMECHANGED,
            GetCursorPos, GetWindowRect,
        };
        use windows::Win32::Foundation::{POINT, RECT};

        if !enabled {
            unsafe {
                let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let new_style = ex_style & !((WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                );
            }
            return;
        }

        let hwnd_raw = hwnd.0 as usize;
        // Start background watcher for mouse over the top-right bar
        tauri::async_runtime::spawn_blocking(move || {
            use windows::Win32::Foundation::HWND;
            let hwnd = HWND(hwnd_raw as *mut _);
            let mut is_transparent = true;
            // Initially set transparent + layered so mouse clicks pass through to under-window
            unsafe {
                let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let new_style = ex_style | (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                );
            }

            let bar_width = (290.0 * scale_factor).round() as i32;
            let bar_height = (54.0 * scale_factor).round() as i32;

            loop {
                std::thread::sleep(std::time::Duration::from_millis(25));

                let state = app.state::<SharedState>();
                let still_enabled = {
                    if let Ok(pins) = state.pins.lock() {
                        pins.get(&pin_id).map(|p| p.click_through).unwrap_or(false)
                    } else {
                        false
                    }
                };

                if !still_enabled {
                    // Restore non-transparent
                    unsafe {
                        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                        let new_style = ex_style & !((WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize);
                        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
                        let _ = SetWindowPos(
                            hwnd,
                            None,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                        );
                    }
                    break;
                }

                unsafe {
                    let mut rect = RECT::default();
                    if GetWindowRect(hwnd, &mut rect).is_err() {
                        // Window was closed or destroyed
                        break;
                    }

                    let mut pt = POINT::default();
                    if GetCursorPos(&mut pt).is_err() {
                        continue;
                    }

                    let bar_left = (rect.right - bar_width).max(rect.left);
                    let bar_top = rect.top;
                    let bar_right = rect.right;
                    let bar_bottom = (rect.top + bar_height).min(rect.bottom);

                    let in_bar = pt.x >= bar_left
                        && pt.x <= bar_right
                        && pt.y >= bar_top
                        && pt.y <= bar_bottom;

                    if in_bar && is_transparent {
                        // Mouse is over top-right bar: remove WS_EX_TRANSPARENT so bar is interactive
                        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                        let new_style = ex_style & !(WS_EX_TRANSPARENT.0 as isize);
                        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
                        let _ = SetWindowPos(
                            hwnd,
                            None,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                        );
                        is_transparent = false;
                    } else if !in_bar && !is_transparent {
                        // Mouse is outside top-right bar: restore WS_EX_TRANSPARENT so clicks pass through
                        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                        let new_style = ex_style | (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
                        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
                        let _ = SetWindowPos(
                            hwnd,
                            None,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
                        );
                        is_transparent = true;
                    }
                }
            }
        });
    }
}

fn save_rgba(rgba: &[u8], width: i32, height: i32, directory: &PathBuf) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory).map_err(|e| format!("创建保存目录失败: {e}"))?;
    let image = image::RgbaImage::from_raw(width as u32, height as u32, rgba.to_vec())
        .ok_or_else(|| "无法创建图像缓冲".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let mut path = directory.join(format!("screenshot_{stamp}.png"));
    let mut suffix = 1;
    while path.exists() {
        path = directory.join(format!("screenshot_{stamp}_{suffix}.png"));
        suffix += 1;
    }
    image.save(&path).map_err(|e| format!("保存失败: {e}"))?;
    Ok(path)
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let p = std::path::Path::new(&path);
        if p.exists() {
            Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", path))
                .spawn()
                .map_err(|e| e.to_string())?;
        } else if let Some(parent) = p.parent() {
            if parent.exists() {
                Command::new("explorer")
                    .raw_arg(format!("\"{}\"", parent.display()))
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let p = std::path::Path::new(&path);
        if p.exists() {
            Command::new("explorer")
                .raw_arg(format!("\"{}\"", path))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_toast<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("toast") {
        hide_toast_window(&window);
    }
    Ok(())
}

#[tauri::command]
fn show_toast<R: Runtime>(
    app: AppHandle<R>,
    options: ToastOptions,
) -> Result<(), String> {
    let kind = options.kind.unwrap_or_else(|| {
        if options.path.is_some() {
            "save".to_string()
        } else {
            "info".to_string()
        }
    });
    let default_msg = match kind.as_str() {
        "save" => "截图已保存",
        "copy" => "已复制到剪贴板",
        "error" => "操作失败",
        _ => "提示",
    };
    let message = options.message.unwrap_or_else(|| default_msg.to_string());
    let subtext = options.subtext.or_else(|| {
        if kind == "copy" {
            Some("已存入剪贴板，可直接粘贴 (Ctrl+V)".to_string())
        } else {
            None
        }
    });
    show_toast_window(
        &app,
        ToastPayload {
            kind,
            path: options.path,
            message,
            subtext,
            duration: options.duration,
        },
    );
    Ok(())
}

fn save_media_file(
    bytes: &[u8],
    ext: &str,
    directory: &PathBuf,
    custom_path: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(target) = custom_path {
        let path = PathBuf::from(target);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
        return Ok(path);
    }
    std::fs::create_dir_all(directory).map_err(|e| format!("创建保存目录失败: {e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let mut path = directory.join(format!("PinShot_Rec_{stamp}.{ext}"));
    let mut suffix = 1;
    while path.exists() {
        path = directory.join(format!("PinShot_Rec_{stamp}_{suffix}.{ext}"));
        suffix += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path)
}

fn record_media_history<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, SharedState>,
    path_str: &str,
    label: &str,
    pixels: Vec<u8>,
    width: i32,
    height: i32,
    x: i32,
    y: i32,
) {
    diagnostics::log(
        "INFO",
        "history",
        format!(
            "record media entered; label={label}; path={path_str}; pixels={}; size={}x{}",
            pixels.len(), width, height
        ),
    );
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let hist_item = HistoryItem {
        id: format!("hist-{}", now),
        width,
        height,
        x,
        y,
        timestamp: now,
        time_str: label.to_string(),
        action: "record".to_string(),
        path: Some(path_str.to_string()),
    };
    if let Ok(mut hist) = state.history.lock() {
        diagnostics::log("INFO", "history", "history lock acquired; inserting media record");
        hist.insert(
            0,
            HistoryRecord {
                item: hist_item,
                pixels,
            },
        );
        if hist.len() > 3 {
            hist.truncate(3);
        }
        diagnostics::log(
            "INFO",
            "history",
            format!("history record inserted; count={}", hist.len()),
        );
    } else {
        diagnostics::log("ERROR", "history", "history lock poisoned; media record skipped");
    }
    diagnostics::log("INFO", "history", "updating tray menu");
    let _ = update_tray_menu(app);
    diagnostics::log("INFO", "history", "tray menu updated; notifying history windows");
    notify_history_updated(app);
    diagnostics::log("INFO", "history", "record media completed");
}

#[tauri::command(async)]
fn start_screen_recording<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedState>,
    session_id: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    fps: Option<u32>,
    record_cursor: Option<bool>,
) -> Result<recorder::RecordingStatus, String> {
    if width <= 0 || height <= 0 || x < 0 || y < 0 {
        return Err("选区尺寸无效".into());
    }
    diagnostics::log(
        "INFO",
        "recording.command",
        format!(
            "start requested; session={session_id}; rect={x},{y} {}x{}; fps={:?}; cursor={:?}",
            width, height, fps, record_cursor
        ),
    );
    if let Some(toast) = app.get_webview_window("toast") {
        hide_toast_window(&toast);
    }
    let (screen_x, screen_y, screen_w, screen_h) = {
        let capture_lock = state.capture.lock().map_err(|_| "capture lock poisoned")?;
        let session = capture_lock
            .as_ref()
            .filter(|s| s.id == session_id)
            .ok_or_else(|| "截图会话已失效".to_string())?;
        (
            session.screen.x + x,
            session.screen.y + y,
            session.screen.width,
            session.screen.height,
        )
    };

    if x.checked_add(width).map_or(true, |right| right > screen_w)
        || y.checked_add(height).map_or(true, |bottom| bottom > screen_h)
    {
        return Err("选区超出当前屏幕范围".into());
    }

    let _start_guard = state.recording_start_gate.try_lock()
        .map_err(|_| "录制正在启动或取消，请稍后重试".to_string())?;
    {
        let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
        if rec_lock.is_some() {
            return Err("已有录制会话，请先导出或取消".into());
        }
    }

    let overlay = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "截图浮层不存在".to_string())?;
    let hwnd = overlay.hwnd().map_err(|e| e.to_string())?;
    capture::punch_overlay_hole(hwnd, x, y, width, height, screen_w, screen_h)?;

    let target_fps = fps.unwrap_or(15).clamp(5, 60);
    let with_cursor = record_cursor.unwrap_or(true);
    state
        .recording_export_cancelled
        .store(false, Ordering::Relaxed);

    let session = match recorder::ActiveRecordingSession::start(
        screen_x,
        screen_y,
        width as u32,
        height as u32,
        target_fps,
        with_cursor,
        hwnd.0 as isize,
    ) {
        Ok(session) => session,
        Err(error) => {
            let _ = capture::restore_overlay_region(hwnd);
            return Err(error);
        }
    };

    let status = session.get_status();
    *state.recording.lock().map_err(|_| "recording lock poisoned")? = Some(session);

    diagnostics::log(
        "INFO",
        "recording.command",
        format!(
            "start completed; frames={}; size={}x{}; state={}",
            status.frame_count, status.width, status.height, status.state
        ),
    );

    Ok(status)
}

#[tauri::command]
fn pause_screen_recording(state: State<'_, SharedState>) -> Result<recorder::RecordingStatus, String> {
    let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
    let session = rec_lock.as_ref().ok_or_else(|| "未处于录制状态".to_string())?;
    session.pause();
    Ok(session.get_status())
}

#[tauri::command]
fn resume_screen_recording(state: State<'_, SharedState>) -> Result<recorder::RecordingStatus, String> {
    let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
    let session = rec_lock.as_ref().ok_or_else(|| "未处于录制状态".to_string())?;
    session.resume();
    Ok(session.get_status())
}

#[tauri::command]
fn get_screen_recording_status(
    state: State<'_, SharedState>,
) -> Result<recorder::RecordingStatus, String> {
    let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
    let session = rec_lock.as_ref().ok_or_else(|| "未处于录制状态".to_string())?;
    Ok(session.get_status())
}

fn restore_recording_overlay(overlay_hwnd: isize) {
    diagnostics::log(
        "INFO",
        "recording.command",
        format!("restoring overlay from cached hwnd=0x{:x}", overlay_hwnd as usize),
    );
    let hwnd = HWND(overlay_hwnd as _);
    match capture::restore_overlay_region(hwnd) {
        Ok(()) => diagnostics::log("INFO", "recording.command", "cached overlay restore completed"),
        Err(error) => diagnostics::log(
            "ERROR",
            "recording.command",
            format!("cached overlay restore failed: {error}"),
        ),
    }
}

#[tauri::command(async)]
fn stop_screen_recording(
    state: State<'_, SharedState>,
) -> Result<recorder::RecordingStatus, String> {
    diagnostics::log("INFO", "recording.command", "stop entered");
    let (status, overlay_hwnd) = {
        let mut rec_lock = state
            .recording
            .lock()
            .map_err(|_| "recording lock poisoned")?;
        let session = rec_lock
            .as_mut()
            .ok_or_else(|| "未处于录制状态".to_string())?;
        session.stop();
        (session.get_status(), session.overlay_hwnd)
    };

    // Do not hold the recording mutex while touching native window state.
    // More importantly, use the handle cached at recording start so this path
    // never calls Tauri's synchronous `window_handle()` getter.
    restore_recording_overlay(overlay_hwnd);

    diagnostics::log(
        "INFO",
        "recording.command",
        format!(
            "stop returned; frames={}; durationMs={}; state={}",
            status.frame_count, status.duration_ms, status.state
        ),
    );
    Ok(status)
}

#[tauri::command(async)]
fn cancel_screen_recording(state: State<'_, SharedState>) -> Result<(), String> {
    let _start_guard = state.recording_start_gate.try_lock()
        .map_err(|_| "录制正在启动或取消，请稍后重试".to_string())?;
    diagnostics::log("INFO", "recording.command", "cancel entered");
    let session = {
        let mut rec_lock = state
            .recording
            .lock()
            .map_err(|_| "recording lock poisoned")?;
        rec_lock.take()
    };
    if let Some(mut session) = session {
        let overlay_hwnd = session.overlay_hwnd;
        session.stop();
        restore_recording_overlay(overlay_hwnd);
    }
    diagnostics::log("INFO", "recording.command", "cancel completed");
    Ok(())
}

#[tauri::command]
fn cancel_recording_export(state: State<'_, SharedState>) -> Result<(), String> {
    state
        .recording_export_cancelled
        .store(true, Ordering::Relaxed);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPreviewInfo {
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingExportProgress {
    phase: &'static str,
    progress: f32,
    current: u32,
    total: u32,
}

fn emit_recording_export_progress<R: Runtime>(
    app: &AppHandle<R>,
    phase: &'static str,
    progress: f32,
    current: usize,
    total: usize,
) {
    let _ = app.emit(
        "recording-export-progress",
        RecordingExportProgress {
            phase,
            progress: progress.clamp(0.0, 1.0),
            current: current.min(u32::MAX as usize) as u32,
            total: total.min(u32::MAX as usize) as u32,
        },
    );
}

#[tauri::command]
fn get_recording_preview_info(
    state: State<'_, SharedState>,
    max_dim: Option<u32>,
) -> Result<RecordingPreviewInfo, String> {
    diagnostics::log(
        "INFO",
        "recording.command",
        format!("preview info entered; maxDim={:?}", max_dim),
    );
    let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
    let session = rec_lock.as_ref().ok_or_else(|| "录制数据已释放".to_string())?;
    // An omitted limit means native resolution. The recorder still caps the
    // number of preview frames to stay within its memory budget.
    let res = session.get_preview_info(max_dim.unwrap_or(u32::MAX));
    let result = RecordingPreviewInfo {
        width: res.width,
        height: res.height,
        frame_count: res.frame_count,
    };
    diagnostics::log(
        "INFO",
        "recording.command",
        format!(
            "preview info returned; frames={}; size={}x{}",
            result.frame_count, result.width, result.height
        ),
    );
    Ok(result)
}

#[tauri::command(async)]
fn get_recording_preview_pixels(
    state: State<'_, SharedState>,
    max_dim: Option<u32>,
) -> Result<Response, String> {
    diagnostics::log(
        "INFO",
        "recording.command",
        format!("preview pixels entered; maxDim={:?}", max_dim),
    );
    let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
    let session = rec_lock.as_ref().ok_or_else(|| "录制数据已释放".to_string())?;
    let res = session.get_preview_frames(max_dim.unwrap_or(u32::MAX))?;
    let bytes = res.pixels.len();
    diagnostics::log(
        "INFO",
        "recording.command",
        format!("preview pixels returned; bytes={bytes}"),
    );
    Ok(Response::new(res.pixels))
}

#[tauri::command(async)]
fn get_recording_frame(
    state: State<'_, SharedState>,
    index: usize,
) -> Result<Response, String> {
    let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
    let session = rec_lock.as_ref().ok_or_else(|| "录制数据已释放".to_string())?;
    let frame_bytes = session.get_frame(index)?;
    Ok(Response::new(frame_bytes))
}

#[tauri::command(async)]
fn export_recording_gif<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedState>,
    options: recorder::GifExportOptions,
    action: String,
    target_path: Option<String>,
) -> Result<ActionResult, String> {
    state
        .recording_export_cancelled
        .store(false, Ordering::Relaxed);
    emit_recording_export_progress(&app, "encode", 0.05, 0, 0);
    let (gif_bytes, first_frame, width, height, screen_x, screen_y) = {
        let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
        let session = rec_lock.as_ref().ok_or_else(|| "录制会话不存在".to_string())?;
        let mut last_progress_emit: Option<Instant> = None;
        let bytes = session.encode_gif_with_progress(&options, |current, total| {
            if state
                .recording_export_cancelled
                .load(Ordering::Relaxed)
            {
                return false;
            }
            let ratio = if total == 0 {
                1.0
            } else {
                current as f32 / total as f32
            };
            // UI events are useful for progress, but emitting one per frame
            // can become more expensive than encoding for long recordings.
            // Keep updates responsive while limiting IPC/event overhead.
            if current != total
                && last_progress_emit.is_some_and(|last| last.elapsed() < Duration::from_millis(80))
            {
                return true;
            }
            last_progress_emit = Some(Instant::now());
            emit_recording_export_progress(
                &app,
                "encode",
                0.05 + ratio * 0.85,
                current,
                total,
            );
            true
        })?;
        let first_pixels = session.get_frame(0).unwrap_or_default();
        (
            bytes,
            first_pixels,
            session.width as i32,
            session.height as i32,
            session.screen_x,
            session.screen_y,
        )
    };

    let config = state
        .config
        .lock()
        .map_err(|_| "config lock poisoned")?
        .clone();
    let save_dir = config.save_directory_path();

    if state
        .recording_export_cancelled
        .load(Ordering::Relaxed)
    {
        return Err("录制导出已取消".into());
    }
    emit_recording_export_progress(&app, "write", 0.92, 0, 0);
    let path = save_media_file(&gif_bytes, "gif", &save_dir, target_path.as_deref())?;
    let path_str = path.to_string_lossy().into_owned();

    let result = match action.as_str() {
        "copy" => {
            let _ = clipboard::copy_file_to_clipboard(HWND::default(), &path);
            ActionResult {
                action: action.clone(),
                path: Some(path_str.clone()),
                pin_id: None,
            }
        }
        _ => {
            show_save_toast(&app, &path_str, "动图已保存");
            ActionResult {
                action: action.clone(),
                path: Some(path_str.clone()),
                pin_id: None,
            }
        }
    };

    emit_recording_export_progress(&app, "finish", 1.0, 1, 1);

    if !first_frame.is_empty() {
        record_media_history(
            &app,
            &state,
            &path_str,
            "动图录制",
            first_frame,
            width,
            height,
            screen_x,
            screen_y,
        );
    }

    Ok(result)
}

#[tauri::command(async)]
fn save_recording_video<R: Runtime>(
    request: Request<'_>,
    app: AppHandle<R>,
    state: State<'_, SharedState>,
) -> Result<ActionResult, String> {
    let format = parse_header(&request, "x-pinshot-format")?;
    let format_lower = format.to_lowercase();
    if !matches!(format_lower.as_str(), "mp4" | "webm") {
        return Err("不支持的视频格式".into());
    }
    let action = parse_header(&request, "x-pinshot-action")?;
    let target_path = parse_header(&request, "x-pinshot-target-path")
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| decode_percent_header(&value))
        .transpose()?;
    let video_bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("视频必须通过二进制上传".into()),
    };
    if video_bytes.is_empty() {
        return Err("视频数据为空".into());
    }
    let (first_frame, width, height, screen_x, screen_y) = {
        let rec_lock = state.recording.lock().map_err(|_| "recording lock poisoned")?;
        if let Some(session) = rec_lock.as_ref() {
            let first_pixels = session.get_frame(0).unwrap_or_default();
            (
                first_pixels,
                session.width as i32,
                session.height as i32,
                session.screen_x,
                session.screen_y,
            )
        } else {
            (Vec::new(), 0, 0, 0, 0)
        }
    };

    let config = state
        .config
        .lock()
        .map_err(|_| "config lock poisoned")?
        .clone();
    let save_dir = config.save_directory_path();
    let ext = if format_lower == "webm" {
        "webm"
    } else {
        "mp4"
    };

    let path = save_media_file(video_bytes, ext, &save_dir, target_path.as_deref())?;
    let path_str = path.to_string_lossy().into_owned();

    let result = match action.as_str() {
        "copy" => {
            let _ = clipboard::copy_file_to_clipboard(HWND::default(), &path);
            ActionResult {
                action: action.clone(),
                path: Some(path_str.clone()),
                pin_id: None,
            }
        }
        _ => {
            show_save_toast(&app, &path_str, "视频已保存");
            ActionResult {
                action: action.clone(),
                path: Some(path_str.clone()),
                pin_id: None,
            }
        }
    };

    if !first_frame.is_empty() {
        let label = if ext == "webm" {
            "WebM 录屏"
        } else {
            "MP4 录屏"
        };
        record_media_history(
            &app,
            &state,
            &path_str,
            label,
            first_frame,
            width,
            height,
            screen_x,
            screen_y,
        );
    }

    Ok(result)
}

#[tauri::command(async)]
fn pick_recording_save_path<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    format: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (filter_name, ext) = match format.to_lowercase().as_str() {
        "mp4" => ("MP4 视频 (*.mp4)", "mp4"),
        "webm" => ("WebM 视频 (*.webm)", "webm"),
        _ => ("GIF 动图 (*.gif)", "gif"),
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let default_name = format!("PinShot_Rec_{stamp}.{ext}");
    diagnostics::log(
        "INFO",
        "recording.dialog",
        format!("save dialog requested; format={ext}; owner={}", window.label()),
    );
    // The recording overlay is fullscreen and always-on-top. An unowned
    // native dialog can open behind it and make export appear to hang.
    // Bind it to the invoking window so Windows keeps the dialog above its
    // owner, and run this blocking wait on Tauri's blocking worker pool.
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("另存为")
        .set_file_name(&default_name)
        .add_filter(filter_name, &[ext])
        .blocking_save_file();
    diagnostics::log(
        "INFO",
        "recording.dialog",
        if picked.is_some() { "save dialog accepted" } else { "save dialog cancelled" },
    );
    Ok(picked.map(|path| path.to_string()))
}
