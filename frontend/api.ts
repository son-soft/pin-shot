import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

async function reportCommandError(source: string, context: string, cause: unknown): Promise<never> {
  // Tauri rejects Rust Result::Err(String) as a string, not an Error instance.
  const error = cause instanceof Error ? cause : new Error(String(cause));
  try {
    await writeDiagnosticLog('error', source, `${context}; error=${error.message}`, error.stack);
  } catch {
    // Preserve the original failure even if diagnostics are unavailable.
  }
  throw error;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface HotkeyBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  winKey: boolean;
  key: string;
}

export interface SettingsDto {
  hotkey: HotkeyBinding;
  saveDirectory: string | null;
  autostart: boolean;
  theme: ThemeMode;
}

export interface DetectedWindow {
  id: number;
  parentId?: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  title?: string | null;
}

export interface CaptureManifest {
  sessionId: string;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  pixelFormat: 'rgba8';
  windows?: DetectedWindow[];
}

export interface PinManifest {
  pinId: string;
  width: number;
  height: number;
  alwaysOnTop: boolean;
  clickThrough?: boolean;
}

export interface ActionResult {
  action: string;
  path: string | null;
  pinId: string | null;
}

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrLineResult {
  text: string;
  score: number;
  boxPoints: OcrPoint[];
  rect: [number, number, number, number];
}

export interface OcrResponse {
  fullText: string;
  lines: OcrLineResult[];
}

type BytePayload = ArrayBuffer | Uint8Array | number[];

function asArrayBuffer(payload: BytePayload): ArrayBuffer {
  if (payload instanceof ArrayBuffer) return payload;
  if (ArrayBuffer.isView(payload)) {
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  }
  return Uint8Array.from(payload).buffer;
}

export const currentWindow = () => getCurrentWindow();

export function getSettings() {
  return invoke<SettingsDto>('get_settings');
}

export function updateSettings(settings: SettingsDto) {
  return invoke<SettingsDto>('update_settings', { draft: settings });
}

export function pickSaveDirectory() {
  return invoke<string | null>('pick_save_directory');
}

export function startCaptureFromUi() {
  return invoke<void>('start_capture_from_ui');
}

export function getActiveCaptureId() {
  return invoke<string | null>('get_active_capture_id');
}

export function getCaptureManifest(sessionId: string) {
  return invoke<CaptureManifest>('get_capture_manifest', { sessionId });
}

export async function getCapturePixels(sessionId: string) {
  return asArrayBuffer(await invoke<BytePayload>('get_capture_pixels', { sessionId }));
}

export function overlayReady(sessionId: string) {
  return invoke<void>('overlay_ready', { sessionId });
}

export interface HistoryItem {
  id: string;
  width: number;
  height: number;
  x: number;
  y: number;
  timestamp: number;
  timeStr: string;
  action: string;
  path?: string | null;
}

export function cancelCapture(
  sessionId: string,
  selection?: { x: number; y: number; width: number; height: number } | null,
) {
  return invoke<void>('cancel_capture', {
    sessionId,
    selection: selection
      ? {
          x: Math.round(selection.x),
          y: Math.round(selection.y),
          width: Math.round(selection.width),
          height: Math.round(selection.height),
        }
      : null,
  });
}

export function getHistoryItems() {
  return invoke<HistoryItem[]>('get_history_items');
}

export function getHistoryItem(id?: string) {
  return invoke<HistoryItem | null>('get_history_item', { id: id ?? null });
}

export async function getHistoryPixels(id?: string) {
  return asArrayBuffer(await invoke<BytePayload>('get_history_pixels', { id: id ?? null }));
}

export function restoreHistoryAsPin(id?: string) {
  return invoke<string>('restore_history_as_pin', { id: id ?? null });
}

export function copyHistoryToClipboard(id?: string) {
  return invoke<void>('copy_history_to_clipboard', { id: id ?? null })
    .catch(cause => reportCommandError('clipboard.history', `id=${id ?? 'latest'}`, cause));
}

export function saveHistoryToFile(id?: string) {
  return invoke<string>('save_history_to_file', { id: id ?? null });
}

export function deleteHistoryItem(id: string) {
  return invoke<void>('delete_history_item', { id });
}

export function clearHistory() {
  return invoke<void>('clear_history');
}

export function showHistoryShelf() {
  return invoke<void>('show_history_shelf_from_ui');
}

export function hideHistoryShelf() {
  return invoke<void>('hide_history_shelf');
}

export function completeCapture(
  sessionId: string,
  action: 'save' | 'copy' | 'pin' | 'ocr',
  rect: { x: number; y: number; width: number; height: number },
  pixels: Uint8ClampedArray,
) {
  const raw = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  return invoke<ActionResult>('complete_capture', raw, {
    headers: {
      'x-pinshot-session': sessionId,
      'x-pinshot-action': action,
      'x-pinshot-x': String(Math.round(rect.x)),
      'x-pinshot-y': String(Math.round(rect.y)),
      'x-pinshot-width': String(Math.round(rect.width)),
      'x-pinshot-height': String(Math.round(rect.height)),
    },
  });
}

export function getPinManifest(pinId: string) {
  return invoke<PinManifest>('get_pin_manifest', { pinId });
}

export async function getPinPixels(pinId: string) {
  return asArrayBuffer(await invoke<BytePayload>('get_pin_pixels', { pinId }));
}

export interface PinInitData {
  pinId: string;
  width: number;
  height: number;
  alwaysOnTop: boolean;
  clickThrough?: boolean;
  pixels: ArrayBuffer;
}

export async function getPinInitData(pinId: string): Promise<PinInitData> {
  const result = await invoke<{
    pinId: string;
    width: number;
    height: number;
    alwaysOnTop: boolean;
    clickThrough?: boolean;
    pixels: BytePayload;
  }>('get_pin_init_data', { pinId });
  return {
    ...result,
    pixels: asArrayBuffer(result.pixels),
  };
}

export function pinReady(pinId: string) {
  return invoke<void>('pin_ready', { pinId });
}

export function pinAction(
  pinId: string,
  action: 'copy' | 'save' | 'toggleTopmost' | 'close' | 'toggleClickThrough' | 'cancelClickThrough' | 'setGhostOpacity' | 'copyText',
  opacity?: number,
) {
  return invoke<ActionResult>('pin_action', { request: { pinId, action, opacity } })
    .catch(cause => reportCommandError('pin.action', `pin=${pinId}; action=${action}`, cause));
}

export function ocrPin(pinId: string): Promise<OcrResponse> {
  return invoke<OcrResponse>('ocr_pin', { pinId })
    .catch(cause => reportCommandError('ocr.pin', `pin=${pinId}`, cause));
}

export function ocrCapture(
  sessionId: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<OcrResponse> {
  return invoke<OcrResponse>('ocr_capture', {
    sessionId,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  }).catch(cause => reportCommandError('ocr.capture', `session=${sessionId}; rect=${JSON.stringify(rect)}`, cause));
}

export function copyTextToClipboard(text: string): Promise<void> {
  return invoke<void>('copy_text_to_clipboard_cmd', { text })
    .catch(cause => reportCommandError('clipboard.text', `chars=${text.length}`, cause));
}

export function showInFolder(path: string) {
  return invoke<void>('show_in_folder', { path });
}

export function openFile(path: string) {
  return invoke<void>('open_file', { path });
}

export function hideToast() {
  return invoke<void>('hide_toast');
}

export interface ToastOptions {
  kind?: 'save' | 'copy' | 'success' | 'error' | 'info';
  path?: string | null;
  message?: string;
  subtext?: string | null;
  duration?: number;
}

export function showToast(options: ToastOptions) {
  return invoke<void>('show_toast', { options });
}

export const appToast = {
  success: (message: string, subtext?: string, duration = 2800) =>
    showToast({ kind: 'success', message, subtext, duration }),
  error: (message: string, subtext?: string, duration = 4500) => {
    // Native errors may carry a short title followed by recovery instructions.
    const [title, ...details] = message.split('\n');
    return showToast({
      kind: 'error',
      message: title,
      subtext: subtext ?? (details.join(' ').trim() || undefined),
      duration: details.length ? Math.max(duration, 8000) : duration,
    });
  },
  info: (message: string, subtext?: string, duration = 2500) =>
    showToast({ kind: 'info', message, subtext, duration }),
  copy: (message = '已复制到剪贴板', subtext = '已存入系统剪贴板，可直接粘贴 (Ctrl+V)', duration = 2800) =>
    showToast({ kind: 'copy', message, subtext, duration }),
  save: (path: string, message = '截图已保存', duration = 4000) =>
    showToast({ kind: 'save', path, message, duration }),
};

export interface LongCaptureStartResult {
  totalHeight: number;
  frameCount: number;
  previewUrl?: string | null;
}

export interface LongCaptureInfo {
  width: number;
  height: number;
}

export interface StitchStepResult {
  deltaY: number;
  totalHeight: number;
  frameCount: number;
  isBottom: boolean;
  confidence: number;
}

export function startLongCapture(
  sessionId: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  return invoke<LongCaptureStartResult>('start_long_capture', {
    sessionId,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

export function longCaptureScrollStep(clicks = -1) {
  return invoke<StitchStepResult>('long_capture_scroll_step', { clicks });
}

export function longCaptureManualFrame() {
  return invoke<StitchStepResult>('long_capture_manual_frame');
}

export function getLongCapturePreview(previewWidth = 180) {
  return invoke<string | null>('get_long_capture_preview', { previewWidth });
}

export function getLongCaptureInfo() {
  return invoke<LongCaptureInfo>('get_long_capture_info');
}

export async function getLongCapturePixels() {
  return asArrayBuffer(await invoke<BytePayload>('get_long_capture_pixels'));
}

export function finishLongCapture(
  action: 'save' | 'copy' | 'pin' | 'ocr',
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
) {
  const raw = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  return invoke<ActionResult>('finish_long_capture', raw, {
    headers: {
      'x-pinshot-action': action,
      'x-pinshot-width': String(Math.round(width)),
      'x-pinshot-height': String(Math.round(height)),
    },
  });
}

export function cancelLongCapture() {
  return invoke<void>('cancel_long_capture');
}

export interface RecordingStatus {
  state: 'recording' | 'paused' | 'stopped';
  frameCount: number;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  capacityReached: boolean;
}

export interface GifExportOptions {
  speed?: number;
  quality?: number;
  scale?: number;
  targetFps?: number;
}

export function startScreenRecording(
  sessionId: string,
  rect: { x: number; y: number; width: number; height: number },
  fps?: number,
  recordCursor?: boolean,
) {
  return invoke<RecordingStatus>('start_screen_recording', {
    sessionId,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    fps,
    recordCursor,
  });
}

export function pauseScreenRecording() {
  return invoke<RecordingStatus>('pause_screen_recording');
}

export function resumeScreenRecording() {
  return invoke<RecordingStatus>('resume_screen_recording');
}

export function getScreenRecordingStatus() {
  return invoke<RecordingStatus>('get_screen_recording_status');
}

export function stopScreenRecording() {
  return invoke<RecordingStatus>('stop_screen_recording');
}

export function cancelScreenRecording() {
  return invoke<void>('cancel_screen_recording');
}

export function getDiagnosticLogPath() {
  return invoke<string>('get_diagnostic_log_path');
}

export function writeDiagnosticLog(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  stack?: string,
) {
  return invoke<void>('write_diagnostic_log', {
    level,
    source,
    message,
    stack,
  });
}

export interface RecordingPreviewInfo {
  width: number;
  height: number;
  frameCount: number;
}

export function getRecordingPreviewInfo(maxDim?: number) {
  return invoke<RecordingPreviewInfo>('get_recording_preview_info', { maxDim });
}

export async function getRecordingPreviewPixels(maxDim?: number) {
  return asArrayBuffer(await invoke<BytePayload>('get_recording_preview_pixels', { maxDim }));
}

export async function getRecordingFrame(index: number) {
  return asArrayBuffer(await invoke<BytePayload>('get_recording_frame', { index }));
}

export function exportRecordingGif(
  options: GifExportOptions,
  action: 'save' | 'copy' | 'save_as',
  targetPath?: string,
) {
  return invoke<ActionResult>('export_recording_gif', {
    options,
    action,
    targetPath,
  });
}

export function saveRecordingVideo(
  format: 'mp4' | 'webm',
  videoBytes: Uint8Array,
  action: 'save' | 'copy' | 'save_as',
  targetPath?: string,
) {
  return invoke<ActionResult>('save_recording_video', videoBytes, {
    headers: {
      'x-pinshot-format': format,
      'x-pinshot-action': action,
      'x-pinshot-target-path': targetPath ? encodeURIComponent(targetPath) : '',
    },
  });
}

export function cancelRecordingExport() {
  return invoke<void>('cancel_recording_export');
}

export function pickRecordingSavePath(format: 'gif' | 'mp4' | 'webm') {
  return invoke<string | null>('pick_recording_save_path', { format });
}


