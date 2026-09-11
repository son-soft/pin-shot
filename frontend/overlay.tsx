import {
  IconClose,
  IconCopy,
  IconFolderOpenStroked,
  IconFont,
  IconPlay,
  IconRedo,
  IconSaveStroked,
  IconStop,
  IconUndo,
} from '@douyinfe/semi-icons';
import { IconPin } from './icons';
import { Button, Slider, Spin, Tooltip, Typography } from '@douyinfe/semi-ui';
import { listen } from '@tauri-apps/api/event';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  appToast,
  cancelCapture,
  cancelLongCapture,
  cancelRecordingExport,
  cancelScreenRecording,
  completeCapture,
  copyTextToClipboard,
  DetectedWindow,
  exportRecordingGif,
  finishLongCapture,
  getCaptureManifest,
  getCapturePixels,
  getLongCaptureInfo,
  getLongCapturePixels,
  getLongCapturePreview,
  getRecordingFrame,
  getRecordingPreviewInfo,
  getRecordingPreviewPixels,
  getScreenRecordingStatus,
  longCaptureManualFrame,
  longCaptureScrollStep,
  ocrCapture,
  OcrResponse,
  overlayReady,
  pauseScreenRecording,
  pickRecordingSavePath,
  RecordingStatus,
  resumeScreenRecording,
  saveRecordingVideo,
  startLongCapture,
  startScreenRecording,
  stopScreenRecording,
  writeDiagnosticLog,
} from './api';
import { encodeFramesToMp4, encodeFramesToWebm } from './video_export';
import {
  clampPoint,
  clampPointToBounds,
  contains,
  cropRect,
  findSnappedWindow,
  handleAt,
  normalizeRect,
  Point,
  Rect,
  resizeFromHandle,
  snapPointToWindowEdges,
  translated,
} from './geometry';
import {
  applyPreset,
  BACKGROUND_PRESETS,
  BEAUTIFY_PRESETS,
  BeautifyConfig,
  calculateBeautifiedDimensions,
  DEFAULT_BEAUTIFY_CONFIG,
  drawBeautifiedBackdrop,
  drawBeautifiedFrame,
  drawBeautifiedHeader,
  drawRoundedRect,
  renderBeautifiedCanvas,
  SHADOW_OPTIONS,
} from './beautify';

type Tool =
  | 'select'
  | 'rectangle'
  | 'ellipse'
  | 'arrow'
  | 'brush'
  | 'step'
  | 'text'
  | 'mosaic'
  | 'blur'
  | 'beautify';

type RecordingExportProgress = {
  phase: 'encode' | 'write' | 'finish';
  progress: number;
  current: number;
  total: number;
};

type Mark = {
  id: number;
  kind: 'rectangle' | 'ellipse' | 'arrow' | 'brush' | 'step' | 'text' | 'mosaic' | 'blur';
  rect: Rect;
  points?: Point[];
  color?: string;
  lineWidth?: number;
  fontSize?: number;
  step?: number;
  padX?: number;
  padY?: number;
  start?: Point;
  end?: Point;
  text?: string;
  bgStyle?: 'none' | 'fill';
};

type Interaction =
  | {
      kind: 'select' | 'move' | 'resize' | 'mark';
      start: { x: number; y: number };
      origin?: Rect;
      handle?: string;
      markKind?: Mark['kind'];
    }
  | {
      kind: 'brush';
      points: Point[];
    }
  | {
      kind: 'move-mark';
      start: { x: number; y: number };
      markId: number;
      originRect: Rect;
      originStart?: Point;
      originEnd?: Point;
      initialMarks: Mark[];
    }
  | {
      kind: 'resize-mark';
      start: { x: number; y: number };
      markId: number;
      originRect: Rect;
      handle: string;
      initialMarks: Mark[];
      originFontSize?: number;
    }
  | {
      kind: 'resize-arrow';
      start: { x: number; y: number };
      markId: number;
      endpoint: 'start' | 'end';
      originStart: Point;
      originEnd: Point;
      initialMarks: Mark[];
    };

const MIN_SIZE = 6;
const COLOR_PALETTE = ['#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#ffffff'];
const LINE_WIDTHS = [
  { label: '细', value: 2 },
  { label: '中', value: 4 },
  { label: '粗', value: 7 },
];
const BLUR_INTENSITIES = [
  { label: '轻度', value: 2 },
  { label: '中度', value: 4 },
  { label: '强力', value: 7 },
];
const STEP_SIZES = [
  { label: '小', value: 24 },
  { label: '中', value: 32 },
  { label: '大', value: 42 },
];
const FONT_SIZES = [
  { label: '小', value: 16 },
  { label: '中', value: 24 },
  { label: '大', value: 32 },
  { label: '特大', value: 42 },
];

function logDiagnostic(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  stack?: string,
) {
  void writeDiagnosticLog(level, source, message, stack).catch(() => {
    // Diagnostics must never interfere with the recording UI.
  });
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export function getTextLineHeight(fontSize: number): number {
  const lh = Math.round(fontSize * 1.32);
  return (lh - fontSize) % 2 !== 0 ? lh + 1 : lh;
}

function isLightColor(hex: string): boolean {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return true;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 130;
}

function hexToRgba(hex: string, alpha: number): string {
  if (!hex || !hex.startsWith('#') || hex.length < 7) {
    return `rgba(250, 204, 21, ${alpha})`;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function findMovableMarkAtPoint(
  point: Point,
  marks: Mark[],
  selectedMarkId?: number | null,
): Mark | undefined {
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    if (mark.kind === 'text' && mark.text && mark.text.trim().length > 0) {
      const fontSize = mark.fontSize || 24;
      const lineHeight = getTextLineHeight(fontSize);
      const lines = mark.text.split('\n');
      const width = Math.max(mark.rect.width, 40);
      const padY = mark.padY ?? (mark.bgStyle === 'fill' ? 8 : 5.5);
      const height = Math.max(mark.rect.height, lines.length * lineHeight + padY * 2);
      if (
        point.x >= mark.rect.x - 4 &&
        point.x <= mark.rect.x + width + 4 &&
        point.y >= mark.rect.y - 4 &&
        point.y <= mark.rect.y + height + 4
      ) {
        return mark;
      }
    }
    if (mark.kind === 'step') {
      const cx = mark.rect.x + mark.rect.width / 2;
      const cy = mark.rect.y + mark.rect.height / 2;
      const radius = mark.rect.width / 2;
      const dist = Math.hypot(point.x - cx, point.y - cy);
      if (dist <= radius + 4) {
        return mark;
      }
    }
    if (mark.kind === 'rectangle' || mark.kind === 'ellipse') {
      const tol = Math.max(8, (mark.lineWidth || 3) + 4);
      const isSelected = selectedMarkId === mark.id;
      const rx = mark.rect.width / 2;
      const ry = mark.rect.height / 2;
      const cx = mark.rect.x + rx;
      const cy = mark.rect.y + ry;

      if (
        point.x >= mark.rect.x - tol &&
        point.x <= mark.rect.x + mark.rect.width + tol &&
        point.y >= mark.rect.y - tol &&
        point.y <= mark.rect.y + mark.rect.height + tol
      ) {
        if (mark.kind === 'rectangle') {
          if (isSelected || mark.rect.width <= tol * 2.5 || mark.rect.height <= tol * 2.5) {
            return mark;
          }
          const onLeft = Math.abs(point.x - mark.rect.x) <= tol;
          const onRight = Math.abs(point.x - (mark.rect.x + mark.rect.width)) <= tol;
          const onTop = Math.abs(point.y - mark.rect.y) <= tol;
          const onBottom = Math.abs(point.y - (mark.rect.y + mark.rect.height)) <= tol;
          if (onLeft || onRight || onTop || onBottom) {
            return mark;
          }
        }
        if (mark.kind === 'ellipse') {
          if (rx > 0 && ry > 0) {
            const normDist = Math.hypot((point.x - cx) / rx, (point.y - cy) / ry);
            if (isSelected && normDist <= 1.05) {
              return mark;
            }
            const radTol = tol / Math.min(rx, ry);
            if (Math.abs(normDist - 1) <= Math.max(0.15, radTol) || normDist <= radTol) {
              return mark;
            }
          }
        }
      }
    }
    if (mark.kind === 'arrow' && mark.start && mark.end) {
      const tol = Math.max(8, (mark.lineWidth || 3) + 4);
      const handleRadius = tol + 4;
      if (
        Math.hypot(point.x - mark.start.x, point.y - mark.start.y) <= handleRadius ||
        Math.hypot(point.x - mark.end.x, point.y - mark.end.y) <= handleRadius
      ) {
        return mark;
      }
      const dx = mark.end.x - mark.start.x;
      const dy = mark.end.y - mark.start.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) {
        if (Math.hypot(point.x - mark.start.x, point.y - mark.start.y) <= tol) {
          return mark;
        }
      } else {
        const t = Math.max(0, Math.min(1, ((point.x - mark.start.x) * dx + (point.y - mark.start.y) * dy) / lenSq));
        const projX = mark.start.x + t * dx;
        const projY = mark.start.y + t * dy;
        const dist = Math.hypot(point.x - projX, point.y - projY);
        if (dist <= tol) {
          return mark;
        }
      }
    }
  }
  return undefined;
}

function arrowHandleAt(mark: Mark, point: Point, radius = 12): 'start' | 'end' | null {
  if (!mark.start || !mark.end) return null;
  if (Math.hypot(point.x - mark.start.x, point.y - mark.start.y) <= radius) {
    return 'start';
  }
  if (Math.hypot(point.x - mark.end.x, point.y - mark.end.y) <= radius) {
    return 'end';
  }
  return null;
}

function findTextMarkAtPoint(point: Point, marks: Mark[]): Mark | undefined {
  const mark = findMovableMarkAtPoint(point, marks);
  return mark && mark.kind === 'text' ? mark : undefined;
}

function measureTextRect(
  text: string,
  fontSize: number,
  x: number,
  y: number,
  scaleX: number,
  bgStyle: 'none' | 'fill' = 'none',
): Rect {
  const lines = text.split('\n');
  const lineHeight = getTextLineHeight(fontSize);
  let maxW = 0;
  const temp = document.createElement('canvas');
  const ctx = temp.getContext('2d');
  if (ctx) {
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif`;
    for (const l of lines) {
      const w = ctx.measureText(l).width;
      if (w > maxW) maxW = w;
    }
  } else {
    maxW = lines.reduce((max, l) => Math.max(max, l.length * fontSize * 0.7), 0);
  }
  const padX = (bgStyle === 'fill' ? 12 : 7.5) / scaleX;
  const padY = (bgStyle === 'fill' ? 8 : 5.5) / scaleX;
  return {
    x,
    y,
    width: Math.max(40, Math.round(maxW + padX * 2)),
    height: Math.max(lineHeight + padY * 2, Math.round(lines.length * lineHeight + padY * 2)),
  };
}

function getCursorForHandle(handle: string): string {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'w':
    case 'e':
      return 'ew-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    default:
      return 'default';
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map(x => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('')
      .toUpperCase()
  );
}

export function Overlay({ sessionId, onFinished }: { sessionId: string; onFinished: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const manifestRef = useRef<{ width: number; height: number } | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const nextMark = useRef(1);

  const [manifest, setManifest] = useState<Awaited<ReturnType<typeof getCaptureManifest>> | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [draftArrow, setDraftArrow] = useState<{ start: Point; end: Point } | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [past, setPast] = useState<Mark[][]>([]);
  const [future, setFuture] = useState<Mark[][]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [activeColor, setActiveColor] = useState('#ef4444');
  const [draftBrushPoints, setDraftBrushPoints] = useState<Point[] | null>(null);
  const [activeShapeMode, setActiveShapeMode] = useState<'rectangle' | 'ellipse'>('rectangle');
  const [activeDrawMode, setActiveDrawMode] = useState<'arrow' | 'brush' | 'step'>('arrow');
  const [activeObfuscateMode, setActiveObfuscateMode] = useState<'blur' | 'mosaic'>('mosaic');
  const [activeLineWidth, setActiveLineWidth] = useState(4);
  const [activeFontSize, setActiveFontSize] = useState(24);
  const [activeStepSize, setActiveStepSize] = useState(32);
  const [manualNextStep, setManualNextStep] = useState<number | null>(null);
  const [activeBgStyle, setActiveBgStyle] = useState<'none' | 'fill'>('none');
  const [selectedMarkId, setSelectedMarkId] = useState<number | null>(null);
  const [hoveredMarkId, setHoveredMarkId] = useState<number | null>(null);
  const [hoveredWindow, setHoveredWindow] = useState<DetectedWindow | null>(null);
  const hoveredWindowRef = useRef<DetectedWindow | null>(null);
  hoveredWindowRef.current = hoveredWindow;

  const nextStepNumber = manualNextStep ?? (() => {
    const stepMarks = marks.filter(m => m.kind === 'step');
    if (stepMarks.length === 0) return 1;
    const maxStep = stepMarks.reduce((max, m) => Math.max(max, m.step || 0), 0);
    return maxStep + 1;
  })();
  const [editing, setEditing] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const originalTextRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const justStartedEditingRef = useRef(false);
  const activeEditingMarkRef = useRef<Mark | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('拖动鼠标框选截图区域 · 按 C 复制鼠标处颜色');
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState('crosshair');

  const [ocrMode, setOcrMode] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrData, setOcrData] = useState<OcrResponse | null>(null);
  const [selectedOcrText, setSelectedOcrText] = useState('');
  const [ocrSelectionPos, setOcrSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const ocrLayerRef = useRef<HTMLDivElement>(null);
  const cachedOcrRef = useRef<{ rect: Rect; marksCount: number; data: OcrResponse } | null>(null);
  const ocrInteractionLocked = ocrLoading || ocrMode;
  const [beautifyConfig, setBeautifyConfig] = useState<BeautifyConfig>(DEFAULT_BEAUTIFY_CONFIG);

  // Long capture states
  const [isLongCapturing, setIsLongCapturing] = useState(false);
  const [longCaptureHeight, setLongCaptureHeight] = useState(0);
  const [longCaptureFrames, setLongCaptureFrames] = useState(0);
  const [longCapturePreview, setLongCapturePreview] = useState<string | null>(null);
  const [longCaptureIsBottom, setLongCaptureIsBottom] = useState(false);
  const [scrollStepLoading, setScrollStepLoading] = useState(false);
  const scrollStepLoadingRef = useRef(false);

  // Recording states
  const [isRecordingPrep, setIsRecordingPrep] = useState(false);
  const [recordingFps, setRecordingFps] = useState(24);
  const [recordCursor, setRecordCursor] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus | null>(null);
  const [recordingExportState, setRecordingExportState] = useState<{
    status: RecordingStatus;
    frames: ImageData[];
  } | null>(null);
  const [exportCurrentIndex, setExportCurrentIndex] = useState(0);
  const [exportIsPlaying, setExportIsPlaying] = useState(false);
  const [exportFormat, setExportFormat] = useState<'gif' | 'mp4' | 'webm'>('gif');
  const [exportSpeed, setExportSpeed] = useState(1.0);
  const [exportGifQuality, setExportGifQuality] = useState<'high' | 'standard'>('high');
  const [exportGifScale, setExportGifScale] = useState(1.0);
  const [exportVideoQuality, setExportVideoQuality] = useState<'high' | 'medium'>('high');
  const [isExporting, setIsExporting] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const previewLoadingRef = useRef(false);
  const previewCancelRef = useRef(false);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingActionRef = useRef(false);
  const exportActionRef = useRef(false);
  const exportCancelRef = useRef(false);
  const capacityToastRef = useRef(false);
  const recordingPollErrorRef = useRef(false);

  useEffect(() => {
    logDiagnostic('info', 'overlay', 'overlay opened; session=' + sessionId);
    return () => {
      logDiagnostic('info', 'overlay', 'overlay unmounted; session=' + sessionId);
    };
  }, [sessionId]);

  // GIF encoding happens in Rust and reports progress through events. Keep
  // one listener for the lifetime of the overlay so the first progress event
  // cannot race the export button's state update.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<RecordingExportProgress>('recording-export-progress', (event) => {
      if (!exportActionRef.current) return;
      const payload = event.payload;
      const progress = Number(payload.progress);
      if (!Number.isFinite(progress)) return;

      setExportProgress(Math.round(Math.max(0, Math.min(1, progress)) * 100));
      if (payload.phase === 'encode') {
        const frameText = payload.total > 0
          ? ` (${payload.current}/${payload.total} 帧)`
          : '';
        setStatus(`正在编码 GIF${frameText}...`);
      } else if (payload.phase === 'write') {
        setStatus('正在写入 GIF 文件...');
      }
    })
      .then((stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch((error) => {
        console.error('recording export progress listener failed', error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const getViewportBounds = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }, []);

  useEffect(() => {
    if (editing !== null) {
      const focusTextarea = () => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          const len = el.value.length;
          el.setSelectionRange(len, len);
          el.style.height = 'auto';
          const mark = marks.find(m => m.id === editing) || activeEditingMarkRef.current;
          const bounds = getViewportBounds();
          const size = manifestRef.current || { width: bounds.width, height: bounds.height };
          const scaleX = bounds.width / size.width;
          const cssFontSize = mark?.fontSize ? Math.round(mark.fontSize * scaleX) : activeFontSize;
          const isFill = (mark?.bgStyle || activeBgStyle) === 'fill';
          const cssLineHeight = getTextLineHeight(cssFontSize);
          const padCssY = isFill ? 6.5 : 4;
          const singleLineHeight = cssLineHeight + Math.round(padCssY * 2) + 3;
          el.style.height = `${Math.max(singleLineHeight, el.scrollHeight)}px`;
        }
      };
      focusTextarea();
      const raf = requestAnimationFrame(focusTextarea);
      const timer = setTimeout(focusTextarea, 50);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [editing, activeFontSize, activeBgStyle, getViewportBounds, marks]);

  // Toolbar ref and measurement for pixel-perfect placement
  const toolbarContainerRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 600, height: 40 });

  // Magnifier / Loupe state for PixPin-style inspection
  const [loupePoint, setLoupePoint] = useState<Point | null>(null);
  const [hoverColor, setHoverColor] = useState<{ hex: string; rgb: string } | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null);

  const toCssRect = useCallback(
    (rect: Rect) => {
      const bounds = getViewportBounds();
      const size = manifestRef.current || { width: bounds.width, height: bounds.height };
      const scaleX = bounds.width / size.width;
      const scaleY = bounds.height / size.height;
      return {
        x: bounds.left + rect.x * scaleX,
        y: bounds.top + rect.y * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      };
    },
    [getViewportBounds],
  );

  useEffect(() => {
    const el = toolbarContainerRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setToolbarSize(prev => {
          if (Math.abs(rect.width - prev.width) > 2 || Math.abs(rect.height - prev.height) > 2) {
            return { width: rect.width, height: rect.height };
          }
          return prev;
        });
      }
    };

    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => measure());
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, [tool, selection, ocrMode, recordingExportState]);

  const pushMarks = useCallback((next: Mark[] | ((old: Mark[]) => Mark[])) => {
    setMarks(old => {
      const value = typeof next === 'function' ? next(old) : next;
      setPast(history => [...history.slice(-39), old]);
      setFuture([]);
      return value;
    });
  }, []);

  const toImagePoint = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const size = manifestRef.current;
    if (!canvas || !size) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return clampPoint(
      {
        x: ((event.clientX - bounds.left) * size.width) / bounds.width,
        y: ((event.clientY - bounds.top) * size.height) / bounds.height,
      },
      size.width,
      size.height,
    );
  }, []);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    const size = manifestRef.current;
    if (!canvas || !base || !size) return;
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The preview bitmap can be smaller than the selected region to keep IPC
    // memory bounded. Ask the browser for its highest-quality interpolation
    // when that bitmap is scaled back onto the overlay canvas.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.drawImage(base, 0, 0);

    // Dark translucent backdrop
    ctx.fillStyle = 'rgba(8, 12, 16, 0.62)';
    ctx.fillRect(0, 0, size.width, size.height);

    const active = selection ?? draft;
    if (active) {
      if (recordingExportState && recordingExportState.frames.length > 0) {
        const frame = recordingExportState.frames[exportCurrentIndex];
        if (frame) {
          if (!previewCanvasRef.current) {
            previewCanvasRef.current = document.createElement('canvas');
          }
          const pCanvas = previewCanvasRef.current;
          if (pCanvas.width !== frame.width || pCanvas.height !== frame.height) {
            pCanvas.width = frame.width;
            pCanvas.height = frame.height;
          }
          const pCtx = pCanvas.getContext('2d');
          if (pCtx) {
            pCtx.putImageData(frame, 0, 0);
            ctx.save();
            ctx.beginPath();
            ctx.rect(active.x, active.y, active.width, active.height);
            ctx.clip();
            ctx.drawImage(pCanvas, active.x, active.y, active.width, active.height);
            ctx.restore();
          }
        }
      } else {
        if (beautifyConfig.enabled) {
          // 1. Draw outer beautified backdrop (gradient/solid background + drop shadow)
          drawBeautifiedBackdrop(ctx, active, beautifyConfig);

          // 2. Draw window content at 100% 1:1 unscaled original pixels with rounded corners
          const headerHeight = beautifyConfig.windowHeader ? 32 : 0;
          const radius = Math.max(0, beautifyConfig.borderRadius);
          const winX = active.x;
          const winY = active.y - headerHeight;
          const winWidth = active.width;
          const winHeight = active.height + headerHeight;

          ctx.save();
          drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
          ctx.clip();
          ctx.drawImage(base, 0, 0);

          // Render marks and drafts at 1:1 scale
          drawMarks(ctx, marks, undefined, editing, selectedMarkId, hoveredMarkId, base);
          if (draft && tool !== 'select' && tool !== 'brush') {
            if (tool === 'arrow' && draftArrow) {
              drawArrow(ctx, draftArrow.start, draftArrow.end, activeColor, activeLineWidth);
            } else {
              drawDraftMark(ctx, draft, tool, activeColor, activeLineWidth);
            }
          }
          if (draftBrushPoints && draftBrushPoints.length > 0 && tool === 'brush') {
            drawBrushStroke(ctx, draftBrushPoints, activeColor, activeLineWidth);
          }
          ctx.restore();

          // 3. Draw macOS window header bar on top of the upper 32px
          drawBeautifiedHeader(ctx, active, beautifyConfig);
        } else {
          // Clear inside selection and draw base image
          ctx.save();
          ctx.beginPath();
          ctx.rect(active.x, active.y, active.width, active.height);
          ctx.clip();
          ctx.drawImage(base, 0, 0);
          ctx.restore();

          // Render marks inside selection
          ctx.save();
          ctx.beginPath();
          ctx.rect(active.x, active.y, active.width, active.height);
          ctx.clip();
          drawMarks(ctx, marks, undefined, editing, selectedMarkId, hoveredMarkId, base);
          if (draft && tool !== 'select' && tool !== 'brush') {
            if (tool === 'arrow' && draftArrow) {
              drawArrow(ctx, draftArrow.start, draftArrow.end, activeColor, activeLineWidth);
            } else {
              drawDraftMark(ctx, draft, tool, activeColor, activeLineWidth);
            }
          }
          if (draftBrushPoints && draftBrushPoints.length > 0 && tool === 'brush') {
            drawBrushStroke(ctx, draftBrushPoints, activeColor, activeLineWidth);
          }
          ctx.restore();
        }
      }

      // Keep the UI stationary and reveal the live scrolling page or live recording area.
      if (isLongCapturing || isRecording) {
        ctx.clearRect(active.x, active.y, active.width, active.height);
      }

      // Border outline
      ctx.save();
      ctx.strokeStyle = isRecording ? '#ef4444' : '#10b981';
      ctx.lineWidth = Math.max(2, size.width / 1400);
      ctx.setLineDash(selection ? [] : [6, 5]);
      if (isLongCapturing || isRecording) {
        if (isLongCapturing && beautifyConfig.enabled) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
          ctx.strokeRect(active.x, active.y, active.width, active.height);
        } else {
          ctx.strokeRect(active.x - 2, active.y - 2, active.width + 4, active.height + 4);
        }
      } else {
        ctx.strokeRect(active.x + 0.5, active.y + 0.5, active.width - 1, active.height - 1);
      }
      ctx.restore();

      // 8 Resize Handles
      if (selection && tool === 'select' && busy !== 'pin' && !ocrInteractionLocked && !isLongCapturing && !isRecording && !recordingExportState) {
        drawHandles(ctx, selection);
      }
    } else if (hoveredWindow) {
      // Smart Window Snapping preview: reveal the hovered window crystal-clear
      ctx.save();
      ctx.beginPath();
      ctx.rect(hoveredWindow.x, hoveredWindow.y, hoveredWindow.width, hoveredWindow.height);
      ctx.clip();
      ctx.drawImage(base, 0, 0);
      // Subtle vibrant emerald highlight
      ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
      ctx.fillRect(hoveredWindow.x, hoveredWindow.y, hoveredWindow.width, hoveredWindow.height);
      ctx.restore();

      // High-contrast primary border
      ctx.save();
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = Math.max(2, size.width / 1400);
      ctx.strokeRect(
        hoveredWindow.x + 0.5,
        hoveredWindow.y + 0.5,
        hoveredWindow.width - 1,
        hoveredWindow.height - 1,
      );

      // Four corner accent brackets for classic Snipaste-level snapping feel
      const bLen = Math.min(22, Math.min(hoveredWindow.width, hoveredWindow.height) / 4);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#34d399';
      ctx.beginPath();
      // TL
      ctx.moveTo(hoveredWindow.x, hoveredWindow.y + bLen);
      ctx.lineTo(hoveredWindow.x, hoveredWindow.y);
      ctx.lineTo(hoveredWindow.x + bLen, hoveredWindow.y);
      // TR
      ctx.moveTo(hoveredWindow.x + hoveredWindow.width - bLen, hoveredWindow.y);
      ctx.lineTo(hoveredWindow.x + hoveredWindow.width, hoveredWindow.y);
      ctx.lineTo(hoveredWindow.x + hoveredWindow.width, hoveredWindow.y + bLen);
      // BL
      ctx.moveTo(hoveredWindow.x, hoveredWindow.y + hoveredWindow.height - bLen);
      ctx.lineTo(hoveredWindow.x, hoveredWindow.y + hoveredWindow.height);
      ctx.lineTo(hoveredWindow.x + bLen, hoveredWindow.y + hoveredWindow.height);
      // BR
      ctx.moveTo(hoveredWindow.x + hoveredWindow.width - bLen, hoveredWindow.y + hoveredWindow.height);
      ctx.lineTo(hoveredWindow.x + hoveredWindow.width, hoveredWindow.y + hoveredWindow.height);
      ctx.lineTo(hoveredWindow.x + hoveredWindow.width, hoveredWindow.y + hoveredWindow.height - bLen);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    draft,
    draftArrow,
    draftBrushPoints,
    marks,
    selection,
    tool,
    activeColor,
    activeLineWidth,
    busy,
    editing,
    selectedMarkId,
    hoveredMarkId,
    hoveredWindow,
    ocrInteractionLocked,
    beautifyConfig,
    isLongCapturing,
    isRecording,
    recordingExportState,
    exportCurrentIndex,
  ]);

  useEffect(() => {
    render();
  }, [render, manifest]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const nextManifest = await getCaptureManifest(sessionId);
        const buffer = await getCapturePixels(sessionId);
        if (cancelled) return;
        if (buffer.byteLength !== nextManifest.width * nextManifest.height * 4) {
          throw new Error('截图数据不完整');
        }
        const base = document.createElement('canvas');
        base.width = nextManifest.width;
        base.height = nextManifest.height;
        base
          .getContext('2d')!
          .putImageData(
            new ImageData(new Uint8ClampedArray(buffer), nextManifest.width, nextManifest.height),
            0,
            0,
          );
        baseRef.current = base;
        manifestRef.current = nextManifest;
        setManifest(nextManifest);
        await overlayReady(sessionId);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法加载截图');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const isLoupeActive = useCallback(() => {
    if (busy || editing !== null || !baseRef.current) return false;
    if (!selection) return true;
    if (interactionRef.current?.kind === 'select') return true;
    return false;
  }, [busy, editing, selection]);

  const drawLoupePreview = useCallback((point: Point) => {
    const loupe = loupeCanvasRef.current;
    const base = baseRef.current;
    if (!loupe || !base) return;
    const lCtx = loupe.getContext('2d');
    if (!lCtx) return;
    const baseCtx = base.getContext('2d');
    if (!baseCtx) return;

    const sampleCount = 15;
    const half = Math.floor(sampleCount / 2); // 7
    const cellSize = loupe.width / sampleCount; // 8px for 120px canvas

    lCtx.imageSmoothingEnabled = false;
    lCtx.clearRect(0, 0, loupe.width, loupe.height);

    const startX = Math.round(point.x) - half;
    const startY = Math.round(point.y) - half;

    try {
      const imageData = baseCtx.getImageData(startX, startY, sampleCount, sampleCount);
      const data = imageData.data;

      for (let py = 0; py < sampleCount; py++) {
        for (let px = 0; px < sampleCount; px++) {
          const idx = (py * sampleCount + px) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3] / 255;

          lCtx.fillStyle = a === 0 ? '#0f172a' : `rgba(${r}, ${g}, ${b}, ${a})`;
          lCtx.fillRect(px * cellSize, py * cellSize, cellSize, cellSize);

          // Subtle pixel grid lines
          lCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          lCtx.lineWidth = 0.75;
          lCtx.strokeRect(px * cellSize, py * cellSize, cellSize, cellSize);
        }
      }
    } catch {
      lCtx.drawImage(
        base,
        startX,
        startY,
        sampleCount,
        sampleCount,
        0,
        0,
        loupe.width,
        loupe.height,
      );
    }

    // High-visibility reticle for the center pixel
    const centerCellX = half * cellSize;
    const centerCellY = half * cellSize;

    lCtx.save();
    // Dark outer contrast outline
    lCtx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    lCtx.lineWidth = 2.5;
    lCtx.strokeRect(centerCellX - 0.5, centerCellY - 0.5, cellSize + 1, cellSize + 1);

    // Primary bright emerald inner outline
    lCtx.strokeStyle = '#10b981';
    lCtx.lineWidth = 1.5;
    lCtx.strokeRect(centerCellX, centerCellY, cellSize, cellSize);
    lCtx.restore();
  }, []);

  // Update pixel loupe when idle or dragging to select
  const updateLoupe = useCallback(
    (point: Point) => {
      if (!isLoupeActive() || !baseRef.current || !manifestRef.current) {
        setLoupePoint(null);
        setHoverColor(null);
        return;
      }
      const manifest = manifestRef.current;
      const clampedX = Math.max(0, Math.min(manifest.width - 1, Math.round(point.x)));
      const clampedY = Math.max(0, Math.min(manifest.height - 1, Math.round(point.y)));
      const nextPoint = { x: clampedX, y: clampedY };
      setLoupePoint(nextPoint);

      const base = baseRef.current;
      const ctx = base.getContext('2d');
      if (!ctx) return;

      try {
        const pixelData = ctx.getImageData(clampedX, clampedY, 1, 1).data;
        const hex = rgbToHex(pixelData[0], pixelData[1], pixelData[2]);
        const rgb = `RGB(${pixelData[0]}, ${pixelData[1]}, ${pixelData[2]})`;
        setHoverColor({ hex, rgb });
        drawLoupePreview(nextPoint);
      } catch {
        // ignore out of bounds
      }
    },
    [isLoupeActive, drawLoupePreview],
  );

  useEffect(() => {
    if (loupePoint) {
      drawLoupePreview(loupePoint);
    }
  }, [loupePoint, drawLoupePreview]);

  const commitEditingText = useCallback(
    (explicitText?: string) => {
      if (editing === null) return;
      const currentId = editing;
      const rawText =
        explicitText !== undefined
          ? explicitText
          : (textareaRef.current?.value ?? editingText);
      const currentText = rawText.trim();
      const bounds = getViewportBounds();
      const size = manifestRef.current || { width: bounds.width, height: bounds.height };
      const scaleX = bounds.width / size.width;

      setMarks(old => {
        const existing =
          old.find(m => m.id === currentId) || activeEditingMarkRef.current;
        if (!existing) return old;

        if (!currentText) {
          const updated = old.filter(m => m.id !== currentId);
          setPast(history => [...history.slice(-39), old]);
          setFuture([]);
          return updated;
        }

        const fontSize = existing.fontSize || Math.round(activeFontSize / scaleX);
        const bgStyle = existing.bgStyle || activeBgStyle;
        const measuredRect = measureTextRect(
          currentText,
          fontSize,
          existing.rect.x,
          existing.rect.y,
          scaleX,
          bgStyle,
        );

        const updatedMark: Mark = {
          ...existing,
          text: currentText,
          rect: measuredRect,
          color: existing.color || activeColor,
          fontSize,
          bgStyle,
          padX: (bgStyle === 'fill' ? 12 : 7.5) / scaleX,
          padY: (bgStyle === 'fill' ? 8 : 5.5) / scaleX,
        };

        const updated = old.some(m => m.id === currentId)
          ? old.map(m => (m.id === currentId ? updatedMark : m))
          : [...old, updatedMark];

        setPast(history => [...history.slice(-39), old]);
        setFuture([]);
        return updated;
      });

      activeEditingMarkRef.current = null;
      setEditing(null);
      setSelectedMarkId(currentId);
    },
    [editing, editingText, activeFontSize, activeColor, activeBgStyle, getViewportBounds],
  );

  const cancelEditingText = useCallback(() => {
    if (editing === null) return;
    const currentId = editing;
    if (!originalTextRef.current) {
      setMarks(old => old.filter(m => m.id !== currentId));
      setSelectedMarkId(null);
    } else {
      setMarks(old =>
        old.map(m => (m.id === currentId ? { ...m, text: originalTextRef.current } : m)),
      );
      setSelectedMarkId(currentId);
    }
    activeEditingMarkRef.current = null;
    setEditing(null);
  }, [editing]);

  const deleteMark = useCallback((id: number) => {
    setMarks(old => {
      const next = old.filter(m => m.id !== id);
      setPast(history => [...history.slice(-39), old]);
      setFuture([]);
      return next;
    });
    if (editing === id) {
      activeEditingMarkRef.current = null;
      setEditing(null);
    }
    setSelectedMarkId(null);
    setStatus('已删除标注');
  }, [editing]);

  const updateEditingColor = useCallback(
    (newColor: string) => {
      const targetId = editing ?? selectedMarkId;
      if (targetId === null) return;
      setMarks(old => old.map(m => (m.id === targetId ? { ...m, color: newColor } : m)));
    },
    [editing, selectedMarkId],
  );

  const updateEditingLineWidth = useCallback(
    (newWidth: number) => {
      setActiveLineWidth(newWidth);
      const targetId = editing ?? selectedMarkId;
      if (targetId !== null) {
        setMarks(old => old.map(m => (m.id === targetId ? { ...m, lineWidth: newWidth } : m)));
      }
    },
    [editing, selectedMarkId],
  );

  const updateEditingFontSize = useCallback(
    (newSizeCss: number) => {
      const targetId = editing ?? selectedMarkId;
      if (targetId === null) return;
      const bounds = getViewportBounds();
      const size = manifestRef.current || { width: bounds.width, height: bounds.height };
      const scaleX = bounds.width / size.width;
      const imageFontSize = Math.round(newSizeCss / scaleX);

      if (activeEditingMarkRef.current && activeEditingMarkRef.current.id === targetId) {
        activeEditingMarkRef.current.fontSize = imageFontSize;
      }

      setMarks(old =>
        old.map(m => {
          if (m.id !== targetId) return m;
          const textToMeasure = (editing === targetId ? (textareaRef.current?.value ?? editingText) : m.text) || '';
          const rect = measureTextRect(
            textToMeasure,
            imageFontSize,
            m.rect.x,
            m.rect.y,
            scaleX,
            m.bgStyle,
          );
          return { ...m, fontSize: imageFontSize, rect };
        }),
      );
    },
    [editing, selectedMarkId, getViewportBounds, editingText],
  );

  const updateDynamicCursor = useCallback(
    (point: Point) => {
      if (interactionRef.current) return;
      if (ocrInteractionLocked || isRecording || recordingExportState) {
        setCursor('default');
        return;
      }
      if (!selection) {
        setCursor('crosshair');
        return;
      }
      if (selectedMarkId !== null) {
        const selectedMark = marks.find(m => m.id === selectedMarkId);
        if (selectedMark && (selectedMark.kind === 'rectangle' || selectedMark.kind === 'ellipse' || (selectedMark.kind === 'text' && editing === null))) {
          const markHandle = handleAt(selectedMark.rect, point, 12);
          if (markHandle) {
            setCursor(getCursorForHandle(markHandle));
            return;
          }
        }
        if (selectedMark && selectedMark.kind === 'arrow') {
          const arrowHandle = arrowHandleAt(selectedMark, point, 12);
          if (arrowHandle) {
            setCursor('crosshair');
            return;
          }
        }
      }
      if (tool === 'text') {
        const textMark = findTextMarkAtPoint(point, marks);
        setCursor(textMark ? 'move' : 'text');
        return;
      }
      if (tool === 'step') {
        const stepMark = findMovableMarkAtPoint(point, marks, selectedMarkId);
        setCursor(stepMark ? 'move' : 'crosshair');
        return;
      }
      if (tool === 'rectangle' || tool === 'ellipse' || tool === 'arrow') {
        const movableMark = findMovableMarkAtPoint(point, marks, selectedMarkId);
        if (movableMark) {
          if (movableMark.kind === 'arrow' && selectedMarkId === movableMark.id) {
            const arrowHandle = arrowHandleAt(movableMark, point, 12);
            if (arrowHandle) {
              setCursor('crosshair');
              return;
            }
          }
          setCursor('move');
          return;
        }
      }
      if (tool === 'select') {
        const handle = handleAt(selection, point);
        if (handle) {
          setCursor(getCursorForHandle(handle));
          return;
        }
        const movableMark = findMovableMarkAtPoint(point, marks, selectedMarkId);
        if (movableMark) {
          setCursor('move');
          return;
        }
        if (contains(selection, point)) {
          setCursor('move');
        } else {
          setCursor('crosshair');
        }
        return;
      }
      setCursor('crosshair');
    },
    [selection, tool, marks, selectedMarkId, ocrInteractionLocked, isRecording, recordingExportState],
  );

  const finishInteraction = (point: Point) => {
    const interaction = interactionRef.current;
    interactionRef.current = null;
    if (!interaction || !manifest) return;

    if (interaction.kind === 'move-mark') {
      const dist = Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y);
      if (dist < 4) {
        const mark = marks.find(m => m.id === interaction.markId);
        if (mark) {
          setSelectedMarkId(mark.id);
          if (mark.color) setActiveColor(mark.color);
          if (mark.lineWidth) setActiveLineWidth(mark.lineWidth);
          if (mark.kind === 'rectangle' || mark.kind === 'ellipse') {
            setActiveShapeMode(mark.kind);
            setStatus(`已选中${mark.kind === 'rectangle' ? '矩形' : '椭圆'}，可拖动边框移动或拖拽手柄调整大小`);
          } else if (mark.kind === 'arrow') {
            setActiveDrawMode('arrow');
            setStatus('已选中箭头，可拖动端点调整方向或拖动箭头移动位置');
          } else if (mark.kind === 'brush') {
            setActiveDrawMode('brush');
            setStatus('已选中画笔');
          } else if (mark.kind === 'text') {
            activeEditingMarkRef.current = mark;
            setEditing(mark.id);
            setEditingText(mark.text || '');
            originalTextRef.current = mark.text || '';
            justStartedEditingRef.current = true;
            setTimeout(() => {
              justStartedEditingRef.current = false;
            }, 300);
            if (mark.fontSize) {
              const bounds = getViewportBounds();
              const size = manifestRef.current || { width: bounds.width, height: bounds.height };
              const scaleX = bounds.width / size.width;
              setActiveFontSize(Math.round(mark.fontSize * scaleX));
            }
            if (mark.bgStyle) setActiveBgStyle(mark.bgStyle);
            setStatus('编辑文字：Enter 完成, Shift+Enter 换行, Esc 取消');
          } else {
            setActiveDrawMode('step');
            setStatus(`已选中序号 ${mark.step ?? ''}`);
          }
        }
      } else {
        setSelectedMarkId(interaction.markId);
        const movedMark = marks.find(m => m.id === interaction.markId);
        if (movedMark?.kind === 'text' && movedMark.fontSize) {
          const bounds = getViewportBounds();
          const size = manifestRef.current || { width: bounds.width, height: bounds.height };
          const scaleX = bounds.width / size.width;
          setActiveFontSize(Math.round(movedMark.fontSize * scaleX));
        }
        setPast(history => [...history.slice(-39), interaction.initialMarks]);
        setFuture([]);
        setStatus('标注位置已调整');
      }
      return;
    }

    if (interaction.kind === 'resize-mark') {
      const mark = marks.find(m => m.id === interaction.markId);
      if (mark) {
        setSelectedMarkId(mark.id);
        setPast(history => [...history.slice(-39), interaction.initialMarks]);
        setFuture([]);
        setStatus(mark.kind === 'text' ? '文字大小已调整' : '图形尺寸已调整');
      }
      return;
    }

    if (interaction.kind === 'resize-arrow') {
      const mark = marks.find(m => m.id === interaction.markId);
      if (mark) {
        setSelectedMarkId(mark.id);
        setPast(history => [...history.slice(-39), interaction.initialMarks]);
        setFuture([]);
        setStatus('箭头尺寸与方向已调整');
      }
      return;
    }

    if (interaction.kind === 'brush') {
      const pts = interaction.points;
      // Skip degenerate brush strokes (single dot from a click)
      const brushExtent = pts.length > 1
        ? Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y)
        : 0;
      if (pts.length > 0 && brushExtent >= 4) {
        let minX = pts[0].x;
        let maxX = pts[0].x;
        let minY = pts[0].y;
        let maxY = pts[0].y;
        for (const p of pts) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const pad = Math.ceil(activeLineWidth / 2) + 2;
        const strokeRect: Rect = {
          x: Math.max(0, minX - pad),
          y: Math.max(0, minY - pad),
          width: Math.max(1, maxX - minX + pad * 2),
          height: Math.max(1, maxY - minY + pad * 2),
        };
        pushMarks(old => [
          ...old,
          {
            id: nextMark.current++,
            kind: 'brush',
            rect: strokeRect,
            points: pts,
            color: activeColor,
            lineWidth: activeLineWidth,
          },
        ]);
        setStatus('画笔笔迹已添加');
      }
      setDraftBrushPoints(null);
      return;
    }

    if (interaction.kind === 'mark') {
      if (interaction.markKind === 'arrow' && draftArrow) {
        const arrowLen = Math.hypot(draftArrow.end.x - draftArrow.start.x, draftArrow.end.y - draftArrow.start.y);
        if (arrowLen < 6) {
          // Too short — likely an accidental click (e.g. first click of a double-click)
          setDraftArrow(null);
          setDraft(null);
          return;
        }
        const newId = nextMark.current++;
        pushMarks(old => [
          ...old,
          {
            id: newId,
            kind: 'arrow',
            rect: normalizeRect(draftArrow.start, draftArrow.end),
            start: draftArrow.start,
            end: draftArrow.end,
            color: activeColor,
            lineWidth: activeLineWidth,
          },
        ]);
        setSelectedMarkId(newId);
        setDraftArrow(null);
        setStatus('箭头已添加，可拖动端点调整方向或拖动箭头移动位置');
      } else {
        const rect = cropRect(normalizeRect(interaction.start, point), manifest);
        if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
          const newId = nextMark.current++;
          pushMarks(old => [
            ...old,
            {
              id: newId,
              kind: interaction.markKind!,
              rect,
              color: activeColor,
              lineWidth: activeLineWidth,
            },
          ]);
          setSelectedMarkId(newId);
          if (interaction.markKind === 'rectangle' || interaction.markKind === 'ellipse') {
            setStatus('图形已创建，可拖动边框移动或拉动控制点调整大小');
          } else {
            setStatus('标注已添加,可继续调整或直接导出');
          }
        }
      }
      setDraft(null);
      return;
    }

    if (interaction.kind === 'select') {
      const dragDist = Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y);
      const activeHovered = hoveredWindowRef.current;

      // 1. Single click on a detected window: direct snap!
      if (dragDist < 6 && activeHovered) {
        const snappedSelection = cropRect(activeHovered, manifest);
        setSelection(snappedSelection);
        setDraft(null);
        setHoveredWindow(null);
        setLoupePoint(null);
        setHoverColor(null);
        setStatus(
          `已智能吸附到窗口${activeHovered.title ? `「${activeHovered.title}」` : ''}，拖动边缘可调整，双击可直接复制`,
        );
        return;
      }

      // 2. Drag selection with magnetic edge snapping
      const snappedPt = snapPointToWindowEdges(point, manifest.windows, 10);
      const rect = cropRect(normalizeRect(interaction.start, snappedPt), manifest);
      if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
        setSelection(rect);
        setDraft(null);
        setHoveredWindow(null);
        setLoupePoint(null);
        setHoverColor(null);
        setStatus('选区就绪：拖动边缘调整,双击直接复制到剪贴板');
      } else if (activeHovered) {
        // Fallback: if movement was tiny but over a window, snap to it
        const snappedSelection = cropRect(activeHovered, manifest);
        setSelection(snappedSelection);
        setDraft(null);
        setHoveredWindow(null);
        setLoupePoint(null);
        setHoverColor(null);
        setStatus(
          `已智能吸附到窗口${activeHovered.title ? `「${activeHovered.title}」` : ''}，拖动边缘可调整，双击可直接复制`,
        );
      } else {
        setSelection(null);
        setDraft(null);
        setStatus('选区太小,请重新框选');
        updateLoupe(point);
      }
      return;
    }

    if (!selection) return;
    if (interaction.kind === 'move') {
      setSelection(
        translated(
          interaction.origin!,
          { x: point.x - interaction.start.x, y: point.y - interaction.start.y },
          manifest,
        ),
      );
    }
    if (interaction.kind === 'resize') {
      setSelection(resizeFromHandle(interaction.origin!, interaction.handle!, point, manifest));
    }
    updateDynamicCursor(point);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (busy || !manifest || ocrInteractionLocked || isLongCapturing || isRecording || recordingExportState) return;
    const point = toImagePoint(event);

    if (editing !== null) {
      commitEditingText();
    }

    if (!selection) {
      setSelectedMarkId(null);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      interactionRef.current = { kind: 'select', start: point };
      setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      updateLoupe(point);
      return;
    }

    if (selectedMarkId !== null) {
      const selectedMark = marks.find(m => m.id === selectedMarkId);
      if (selectedMark && (selectedMark.kind === 'rectangle' || selectedMark.kind === 'ellipse' || (selectedMark.kind === 'text' && editing === null))) {
        const markHandle = handleAt(selectedMark.rect, point, 12);
        if (markHandle) {
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          interactionRef.current = {
            kind: 'resize-mark',
            start: point,
            markId: selectedMark.id,
            originRect: { ...selectedMark.rect },
            handle: markHandle,
            initialMarks: marks,
            originFontSize: selectedMark.fontSize || 24,
          };
          setCursor(getCursorForHandle(markHandle));
          return;
        }
      }
      if (selectedMark && selectedMark.kind === 'arrow' && selectedMark.start && selectedMark.end) {
        const arrowHandle = arrowHandleAt(selectedMark, point, 12);
        if (arrowHandle) {
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          interactionRef.current = {
            kind: 'resize-arrow',
            start: point,
            markId: selectedMark.id,
            endpoint: arrowHandle,
            originStart: { ...selectedMark.start },
            originEnd: { ...selectedMark.end },
            initialMarks: marks,
          };
          setCursor('crosshair');
          return;
        }
      }
    }

    if (tool === 'select' || tool === 'text' || tool === 'rectangle' || tool === 'ellipse' || tool === 'arrow') {
      const clickedMovable = findMovableMarkAtPoint(point, marks, selectedMarkId);
      if (clickedMovable) {
        const isShape = clickedMovable.kind === 'rectangle' || clickedMovable.kind === 'ellipse';
        const isArrow = clickedMovable.kind === 'arrow';
        if (
          tool === 'select' ||
          (tool === 'text' && clickedMovable.kind === 'text') ||
          ((tool === 'rectangle' || tool === 'ellipse') && (isShape || clickedMovable.id === selectedMarkId)) ||
          (tool === 'arrow' && (isArrow || clickedMovable.id === selectedMarkId))
        ) {
          setSelectedMarkId(clickedMovable.id);
          if (clickedMovable.color) setActiveColor(clickedMovable.color);
          if (clickedMovable.lineWidth) setActiveLineWidth(clickedMovable.lineWidth);
          if (clickedMovable.bgStyle) setActiveBgStyle(clickedMovable.bgStyle);
          if (clickedMovable.kind === 'text' && clickedMovable.fontSize) {
            const bounds = getViewportBounds();
            const size = manifestRef.current || { width: bounds.width, height: bounds.height };
            const scaleX = bounds.width / size.width;
            setActiveFontSize(Math.round(clickedMovable.fontSize * scaleX));
          }
          if (isShape) {
            setActiveShapeMode(clickedMovable.kind as 'rectangle' | 'ellipse');
          } else if (clickedMovable.kind === 'arrow' || clickedMovable.kind === 'brush' || clickedMovable.kind === 'step') {
            setActiveDrawMode(clickedMovable.kind);
          }
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          interactionRef.current = {
            kind: 'move-mark',
            start: point,
            markId: clickedMovable.id,
            originRect: { ...clickedMovable.rect },
            originStart: clickedMovable.start ? { ...clickedMovable.start } : undefined,
            originEnd: clickedMovable.end ? { ...clickedMovable.end } : undefined,
            initialMarks: marks,
          };
          return;
        }
      } else if (tool === 'select') {
        setSelectedMarkId(null);
      }
    }

    if (tool === 'step') {
      if (contains(selection, point)) {
        const clickedStep = findMovableMarkAtPoint(point, marks, selectedMarkId);
        if (clickedStep && clickedStep.kind === 'step') {
          setSelectedMarkId(clickedStep.id);
          setActiveDrawMode('step');
          if (clickedStep.color) setActiveColor(clickedStep.color);
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          interactionRef.current = {
            kind: 'move-mark',
            start: point,
            markId: clickedStep.id,
            originRect: { ...clickedStep.rect },
            initialMarks: marks,
          };
          return;
        }

        const bounds = getViewportBounds();
        const size = manifestRef.current || { width: bounds.width, height: bounds.height };
        const scaleX = bounds.width / size.width;
        const cssRadius = activeStepSize / 2;
        const imageRadius = Math.round(cssRadius / scaleX);

        const newId = nextMark.current++;
        const newStepMark: Mark = {
          id: newId,
          kind: 'step',
          rect: {
            x: point.x - imageRadius,
            y: point.y - imageRadius,
            width: imageRadius * 2,
            height: imageRadius * 2,
          },
          color: activeColor,
          step: nextStepNumber,
          fontSize: Math.round(imageRadius * 1.1),
        };
        pushMarks(old => [...old, newStepMark]);
        setSelectedMarkId(newId);
        setStatus(`已添加序号 ${nextStepNumber}，点击可继续添加序号 ${nextStepNumber + 1}`);
      }
      return;
    }

    if (tool === 'brush') {
      if (contains(selection, point)) {
        setSelectedMarkId(null);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        interactionRef.current = {
          kind: 'brush',
          points: [point],
        };
        setDraftBrushPoints([point]);
      }
      return;
    }

    if (
      tool === 'rectangle' ||
      tool === 'ellipse' ||
      tool === 'arrow' ||
      tool === 'mosaic' ||
      tool === 'blur'
    ) {
      if (contains(selection, point)) {
        setSelectedMarkId(null);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        interactionRef.current = {
          kind: 'mark',
          start: point,
          markKind: tool,
        };
        if (tool === 'arrow') {
          setDraftArrow({ start: point, end: point });
        }
        setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      }
      return;
    }

    if (tool === 'text') {
      if (contains(selection, point)) {
        const bounds = getViewportBounds();
        const size = manifestRef.current || { width: bounds.width, height: bounds.height };
        const scaleX = bounds.width / size.width;
        const scaleY = bounds.height / size.height;

        const imageFontSize = Math.round(activeFontSize / scaleX);
        const lineHeight = getTextLineHeight(imageFontSize);
        const padX = (activeBgStyle === 'fill' ? 12 : 7.5) / scaleX;
        const padY = (activeBgStyle === 'fill' ? 8 : 5.5) / scaleY;
        const initialHeight = lineHeight + padY * 2;

        // Click point should align with the vertical waist (center) of the text
        let initialY = point.y - initialHeight / 2;
        if (selection) {
          initialY = Math.max(selection.y, Math.min(selection.y + selection.height - initialHeight, initialY));
        }

        const newId = nextMark.current++;
        const newMark: Mark = {
          id: newId,
          kind: 'text',
          rect: {
            x: point.x,
            y: initialY,
            width: Math.max(160 / scaleX, Math.min(320 / scaleX, selection.x + selection.width - point.x)),
            height: initialHeight,
          },
          text: '',
          color: activeColor,
          fontSize: imageFontSize,
          bgStyle: activeBgStyle,
          padX,
          padY,
        };
        activeEditingMarkRef.current = newMark;
        pushMarks(old => [...old, newMark]);
        setEditing(newId);
        setSelectedMarkId(newId);
        setEditingText('');
        originalTextRef.current = '';
        justStartedEditingRef.current = true;
        setTimeout(() => {
          justStartedEditingRef.current = false;
        }, 300);
        setTimeout(() => {
          textareaRef.current?.focus();
        }, 0);
        setStatus('输入文字：Enter 完成, Shift+Enter 换行, Esc 取消');
      }
      return;
    }

    const handle = handleAt(selection, point);
    if (handle) {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      interactionRef.current = { kind: 'resize', start: point, origin: selection, handle };
      setCursor(getCursorForHandle(handle));
    } else if (contains(selection, point)) {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      interactionRef.current = { kind: 'move', start: point, origin: selection };
      setCursor('grabbing');
    } else {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      interactionRef.current = { kind: 'select', start: point };
      setSelection(null);
      setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      setCursor('crosshair');
      updateLoupe(point);
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (ocrInteractionLocked || isRecording || recordingExportState) return;
    const point = toImagePoint(event);
    const interaction = interactionRef.current;

    if (!interaction) {
      if (!selection && manifest?.windows) {
        const snapped = findSnappedWindow(point, manifest.windows);
        setHoveredWindow(snapped);
      } else if (hoveredWindow) {
        setHoveredWindow(null);
      }
      const movableMark = findMovableMarkAtPoint(point, marks, selectedMarkId);
      setHoveredMarkId(movableMark ? movableMark.id : null);
      if (editing !== null) return;
      updateLoupe(point);
      updateDynamicCursor(point);
      return;
    }

    if (interaction.kind === 'move-mark') {
      const bounds = selection || (manifest ? { x: 0, y: 0, width: manifest.width, height: manifest.height } : { x: 0, y: 0, width: 4000, height: 4000 });
      const nextRect = translated(
        interaction.originRect,
        { x: point.x - interaction.start.x, y: point.y - interaction.start.y },
        bounds,
      );
      const actualDx = nextRect.x - interaction.originRect.x;
      const actualDy = nextRect.y - interaction.originRect.y;
      setMarks(old =>
        old.map(m => {
          if (m.id !== interaction.markId) return m;
          if (interaction.originStart && interaction.originEnd) {
            return {
              ...m,
              rect: nextRect,
              start: { x: interaction.originStart.x + actualDx, y: interaction.originStart.y + actualDy },
              end: { x: interaction.originEnd.x + actualDx, y: interaction.originEnd.y + actualDy },
            };
          }
          return { ...m, rect: nextRect };
        }),
      );
      setCursor('move');
      return;
    }

    if (interaction.kind === 'resize-mark') {
      const bounds = selection || (manifest ? { x: 0, y: 0, width: manifest.width, height: manifest.height } : { x: 0, y: 0, width: 4000, height: 4000 });
      const nextRect = resizeFromHandle(interaction.originRect, interaction.handle, point, bounds);
      const targetMark = marks.find(m => m.id === interaction.markId);
      if (targetMark && targetMark.kind === 'text') {
        const originH = interaction.originRect.height || 30;
        const originW = interaction.originRect.width || 40;
        const scaleH = nextRect.height / originH;
        const scaleW = nextRect.width / originW;
        const isCorner = interaction.handle.length === 2;
        const rawScale = isCorner
          ? Math.max(scaleH, scaleW)
          : (interaction.handle === 'n' || interaction.handle === 's' ? scaleH : scaleW);
        const scale = Math.max(0.2, rawScale);
        const originFontSize = interaction.originFontSize || 24;
        const newFontSize = Math.max(12, Math.min(72, Math.round(originFontSize * scale)));
        const vBounds = getViewportBounds();
        const size = manifestRef.current || { width: vBounds.width, height: vBounds.height };
        const scaleX = vBounds.width / size.width;
        const measured = measureTextRect(
          targetMark.text || '',
          newFontSize,
          nextRect.x,
          nextRect.y,
          scaleX,
          targetMark.bgStyle,
        );
        const hasW = interaction.handle.includes('w');
        const hasN = interaction.handle.includes('n');
        const originRight = interaction.originRect.x + interaction.originRect.width;
        const originBottom = interaction.originRect.y + interaction.originRect.height;
        if (hasW) {
          measured.x = originRight - measured.width;
        }
        if (hasN) {
          measured.y = originBottom - measured.height;
        }
        setMarks(old =>
          old.map(m =>
            m.id === interaction.markId
              ? { ...m, fontSize: newFontSize, rect: measured }
              : m,
          ),
        );
        const newCss = Math.round(newFontSize * scaleX);
        setActiveFontSize(newCss);
        setStatus(`文字大小: ${newCss}px`);
      } else {
        setMarks(old =>
          old.map(m =>
            m.id === interaction.markId
              ? { ...m, rect: nextRect }
              : m,
          ),
        );
      }
      setCursor(getCursorForHandle(interaction.handle));
      return;
    }

    if (interaction.kind === 'resize-arrow') {
      const bounds = selection || (manifest ? { x: 0, y: 0, width: manifest.width, height: manifest.height } : { x: 0, y: 0, width: 4000, height: 4000 });
      const clampedPt = clampPointToBounds(point, bounds);
      const nextStart = interaction.endpoint === 'start' ? clampedPt : interaction.originStart;
      const nextEnd = interaction.endpoint === 'end' ? clampedPt : interaction.originEnd;
      const nextRect = normalizeRect(nextStart, nextEnd);
      setMarks(old =>
        old.map(m =>
          m.id === interaction.markId
            ? { ...m, rect: nextRect, start: nextStart, end: nextEnd }
            : m,
        ),
      );
      setCursor('crosshair');
      return;
    }

    if (interaction.kind === 'brush') {
      interaction.points.push(point);
      setDraftBrushPoints([...interaction.points]);
      return;
    }

    if (interaction.kind === 'select') {
      const snappedPt = snapPointToWindowEdges(point, manifest?.windows, 10);
      setDraft(normalizeRect(interaction.start, snappedPt));
      updateLoupe(snappedPt);
    }
    if (interaction.kind === 'mark') {
      if (interaction.markKind === 'arrow') {
        setDraftArrow({ start: interaction.start, end: point });
      }
      setDraft(normalizeRect(interaction.start, point));
    }
    if (interaction.kind === 'move' && interaction.origin) {
      setSelection(
        translated(
          interaction.origin,
          { x: point.x - interaction.start.x, y: point.y - interaction.start.y },
          manifest!,
        ),
      );
    }
    if (interaction.kind === 'resize' && interaction.origin) {
      const snappedPt = snapPointToWindowEdges(point, manifest?.windows, 10);
      setSelection(resizeFromHandle(interaction.origin, interaction.handle!, snappedPt, manifest!));
    }
  };

  const exportSelection = async (action: 'save' | 'copy' | 'pin' | 'ocr') => {
    if (!selection || !baseRef.current || busy || ocrInteractionLocked) return;
    const rect = cropRect(selection, manifest!);
    setBusy(action);
    setStatus(action === 'pin' ? '正在创建钉图…' : action === 'ocr' ? '正在识别文字…' : '正在处理…');
    try {
      let marksToDraw = marks;
      if (editing !== null && editingText.trim().length > 0) {
        const bounds = getViewportBounds();
        const size = manifestRef.current || { width: bounds.width, height: bounds.height };
        const scaleX = bounds.width / size.width;
        const fontSize = Math.round(activeFontSize / scaleX);
        const existing = marks.find(m => m.id === editing);
        if (existing) {
          const bgStyle = existing.bgStyle || activeBgStyle;
          marksToDraw = marks.map(m =>
            m.id === editing
              ? {
                  ...m,
                  text: editingText.trim(),
                  fontSize,
                  bgStyle,
                  rect: measureTextRect(editingText.trim(), fontSize, m.rect.x, m.rect.y, scaleX, bgStyle),
                }
              : m,
          );
        }
      }
      marksToDraw = marksToDraw.filter(
        m => m.kind !== 'text' || (m.text && m.text.trim().length > 0),
      );

      const output = document.createElement('canvas');
      output.width = rect.width;
      output.height = rect.height;
      const ctx = output.getContext('2d')!;
      ctx.drawImage(
        baseRef.current,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height,
      );
      drawMarks(ctx, marksToDraw, rect, null, null, null, baseRef.current);

      let finalCanvas = output;
      let finalRect = rect;
      if (beautifyConfig.enabled && action !== 'ocr') {
        finalCanvas = renderBeautifiedCanvas(output, beautifyConfig);
        const dims = calculateBeautifiedDimensions(rect.width, rect.height, beautifyConfig);
        finalRect = {
          x: Math.max(0, rect.x - dims.innerX),
          y: Math.max(0, rect.y - dims.innerY),
          width: dims.width,
          height: dims.height,
        };
      }

      const pixels = finalCanvas.getContext('2d')!.getImageData(
        0,
        0,
        finalCanvas.width,
        finalCanvas.height,
      ).data;
      const result = await completeCapture(sessionId, action, finalRect, pixels);
      setStatus(
        action === 'save'
          ? `已保存：${result.path ?? ''}`
          : action === 'ocr'
            ? '已提取并复制文字'
            : '已复制到剪贴板',
      );
      if (action !== 'pin') {
        onFinished();
      }
    } catch (cause) {
      setBusy(null);
      setStatus('操作失败');
      appToast.error(cause instanceof Error ? cause.message : '操作失败');
    }
  };

  const undo = () => {
    if (!past.length) return;
    const previous = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture([marks, ...future]);
    setMarks(previous);
  };

  const redo = () => {
    if (!future.length) return;
    const next = future[0];
    setFuture(future.slice(1));
    setPast([...past, marks]);
    setMarks(next);
  };

  const cancel = async () => {
    const activeSel = selection ?? draft;
    await cancelCapture(
      sessionId,
      activeSel && activeSel.width >= 32 && activeSel.height >= 32 ? activeSel : undefined,
    );
    onFinished();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || busy || !selection || !manifest || ocrInteractionLocked) return;
    const point = toImagePoint(event);
    const clickedText = findTextMarkAtPoint(point, marks);
    if (clickedText) {
      activeEditingMarkRef.current = clickedText;
      setEditing(clickedText.id);
      setSelectedMarkId(clickedText.id);
      setEditingText(clickedText.text || '');
      originalTextRef.current = clickedText.text || '';
      if (clickedText.color) setActiveColor(clickedText.color);
      if (clickedText.bgStyle) setActiveBgStyle(clickedText.bgStyle);
      if (clickedText.fontSize) {
        const bounds = getViewportBounds();
        const size = manifestRef.current || { width: bounds.width, height: bounds.height };
        const scaleX = bounds.width / size.width;
        setActiveFontSize(Math.round(clickedText.fontSize * scaleX));
      }
      return;
    }
    // Double-click anywhere with an active selection → quick copy & exit
    // Undo any accidental mark created by the first click of the double-click
    // (e.g. step markers created on pointerDown, tiny arrows/rects from finishInteraction)
    if (tool !== 'select' && past.length > 0) {
      const lastState = past[past.length - 1];
      setMarks(lastState);
      setPast(h => h.slice(0, -1));
      setFuture([]);
    }
    void exportSelection('copy');
  };

  const onWheel = (event: React.WheelEvent) => {
    if (isLongCapturing) {
      event.preventDefault();
      if (event.deltaY > 0) {
        void triggerLongCaptureStep(-1);
      }
      return;
    }
    if (busy || !selection || !manifest || ocrInteractionLocked) return;
    const point = toImagePoint(event);
    const hoveredText = findTextMarkAtPoint(point, marks);
    const targetMark =
      editing !== null
        ? (marks.find(m => m.id === editing) || activeEditingMarkRef.current)
        : (hoveredText || (selectedMarkId !== null ? marks.find(m => m.id === selectedMarkId) : null));

    if (targetMark && targetMark.kind === 'text') {
      event.preventDefault();
      const bounds = getViewportBounds();
      const size = manifestRef.current || { width: bounds.width, height: bounds.height };
      const scaleX = bounds.width / size.width;
      const delta = event.deltaY < 0 ? 2 : -2;
      const currentCss = Math.round((targetMark.fontSize || 24) * scaleX);
      const newCss = Math.max(12, Math.min(72, currentCss + delta));
      const newImageFontSize = Math.round(newCss / scaleX);

      setActiveFontSize(newCss);
      if (activeEditingMarkRef.current && activeEditingMarkRef.current.id === targetMark.id) {
        activeEditingMarkRef.current.fontSize = newImageFontSize;
      }
      setMarks(old =>
        old.map(m =>
          m.id === targetMark.id
            ? {
                ...m,
                fontSize: newImageFontSize,
                rect: measureTextRect(
                  (editing === m.id ? (textareaRef.current?.value ?? editingText) : m.text) || '',
                  newImageFontSize,
                  m.rect.x,
                  m.rect.y,
                  scaleX,
                  m.bgStyle,
                ),
              }
            : m,
        ),
      );
      setStatus(`文字大小: ${newCss}px`);
    }
  };

  // Monitor text selection within overlay in OCR extraction mode
  useEffect(() => {
    if (!ocrMode) {
      setSelectedOcrText('');
      setOcrSelectionPos(null);
      return;
    }
    const handleSelection = () => {
      const sel = window.getSelection();
      const layer = ocrLayerRef.current;
      if (!sel || sel.isCollapsed || !layer || sel.rangeCount === 0) {
        setSelectedOcrText('');
        setOcrSelectionPos(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) {
        setSelectedOcrText('');
        setOcrSelectionPos(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length > 0) {
        setSelectedOcrText(text);
        try {
          const rect = range.getBoundingClientRect();
          setOcrSelectionPos({
            x: Math.max(10, Math.min(window.innerWidth - 140, rect.left + rect.width / 2 - 55)),
            y: Math.max(8, rect.top - 38),
          });
        } catch {
          setOcrSelectionPos(null);
        }
      } else {
        setSelectedOcrText('');
        setOcrSelectionPos(null);
      }
    };

    document.addEventListener('selectionchange', handleSelection);
    return () => document.removeEventListener('selectionchange', handleSelection);
  }, [ocrMode]);

  const runOcrExtract = async () => {
    if (!selection || !manifest || busy || ocrInteractionLocked) return;
    const rect = cropRect(selection, manifest);
    // Freeze the source selection before the async recognition begins.  OCR
    // coordinates are relative to this rectangle, so changing it mid-flight
    // would make the returned text layer drift away from the source image.
    interactionRef.current = null;
    setDraft(null);
    setDraftArrow(null);
    setDraftBrushPoints(null);
    setHoveredMarkId(null);
    setLoupePoint(null);
    setHoverColor(null);
    setCursor('default');
    if (editing !== null) commitEditingText();

    // Fast-path cache: if exact same selection rect and marks were already recognized, restore instantly!
    const cached = cachedOcrRef.current;
    if (
      cached &&
      cached.rect.x === rect.x &&
      cached.rect.y === rect.y &&
      cached.rect.width === rect.width &&
      cached.rect.height === rect.height &&
      cached.marksCount === marks.length
    ) {
      setOcrData(cached.data);
      setOcrMode(true);
      setStatus('提取模式');
      return;
    }

    setOcrLoading(true);
    setStatus('正在识别文字…');
    try {
      const res = await ocrCapture(sessionId, rect);
      cachedOcrRef.current = { rect, marksCount: marks.length, data: res };
      setOcrData(res);
      setOcrMode(true);
      if (!res.lines || res.lines.length === 0) {
        appToast.info('选区未检测到文字');
        setStatus('选区未检测到文字');
      } else {
        setStatus('提取模式');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appToast.error(`文字识别失败: ${msg}`);
      setStatus('文字识别失败');
    } finally {
      setOcrLoading(false);
    }
  };

  const finishOcrCapture = async () => {
    try {
      const activeSel = selection ?? draft;
      await cancelCapture(
        sessionId,
        activeSel && activeSel.width >= 32 && activeSel.height >= 32 ? activeSel : undefined,
      );
    } catch {
      // The session may have been closed by another capture action.  The
      // frontend still needs to leave this overlay in that case.
    } finally {
      // The native overlay must be dismissed even if its session was already
      // closed.  Otherwise an empty, still input-blocking overlay remains.
      onFinished();
    }
  };

  const copySelectedOcrText = async (finish = true) => {
    if (!selectedOcrText) return;
    try {
      await copyTextToClipboard(selectedOcrText);
      if (finish) {
        await finishOcrCapture();
      }
    } catch {
      appToast.error('复制失败');
    }
  };

  const copyAllOcrText = async (finish = true) => {
    if (!ocrData || !ocrData.fullText.trim()) {
      appToast.info('未识别到文字');
      return;
    }
    try {
      await copyTextToClipboard(ocrData.fullText);
      if (finish) {
        await finishOcrCapture();
      }
    } catch {
      appToast.error('复制失败');
    }
  };

  const exitOcrMode = () => {
    setOcrMode(false);
    setSelectedOcrText('');
    setOcrSelectionPos(null);
    window.getSelection()?.removeAllRanges();
    setStatus('已退出提取模式');
  };

  const triggerLongCaptureStep = async (clicks = -1) => {
    if (scrollStepLoadingRef.current) return;
    // React state updates are asynchronous; set the ref immediately so a
    // wheel burst cannot enqueue multiple native scroll operations.
    scrollStepLoadingRef.current = true;
    setScrollStepLoading(true);
    try {
      const res = await longCaptureScrollStep(clicks);
      setLongCaptureHeight(res.totalHeight);
      setLongCaptureFrames(res.frameCount);
      if (res.isBottom) {
        setLongCaptureIsBottom(true);
        setStatus('长截图：已到达页面底部');
      }
      const preview = await getLongCapturePreview(180);
      if (preview) {
        setLongCapturePreview(preview);
      }
    } catch (err) {
      console.error('长截图滚动捕获失败', err);
      appToast.error('长截图滚动捕获失败', String(err));
    } finally {
      scrollStepLoadingRef.current = false;
      setScrollStepLoading(false);
    }
  };

  const startLongCaptureFlow = async () => {
    if (!selection || !sessionId || busy) return;
    if (editing !== null) commitEditingText();
    setBusy('正在启动长截图视口...');
    try {
      const res = await startLongCapture(sessionId, selection);
      setTool('select');
      setIsLongCapturing(true);
      setLongCaptureHeight(res.totalHeight);
      setLongCaptureFrames(res.frameCount);
      setLongCapturePreview(res.previewUrl ?? null);
      setLongCaptureIsBottom(false);
      setStatus('长截图模式：可滚动鼠标滚轮 或 点击向下滚动');
    } catch (err) {
      appToast.error('启动长截图失败', String(err));
    } finally {
      setBusy(null);
    }
  };

  const completeLongCaptureFlow = async (action: 'save' | 'copy') => {
    setBusy('正在导出长截图...');
    // Await any in-flight scroll/capture step to cleanly finish before exporting
    let waitCount = 0;
    while (scrollStepLoadingRef.current && waitCount < 30) {
      await new Promise(resolve => setTimeout(resolve, 50));
      waitCount++;
    }
    // Hold the same guard while reading and exporting the assembled pixels;
    // otherwise the 250ms manual-frame timer could mutate the stitcher
    // between the dimension query and the final upload.
    scrollStepLoadingRef.current = true;
    try {
      const info = await getLongCaptureInfo();
      const rawPixels = await getLongCapturePixels();
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = info.width;
      sourceCanvas.height = info.height;
      const sourceCtx = sourceCanvas.getContext('2d');
      if (!sourceCtx) throw new Error('无法创建长截图画布');
      const imageData = sourceCtx.createImageData(info.width, info.height);
      imageData.data.set(new Uint8ClampedArray(rawPixels));
      sourceCtx.putImageData(imageData, 0, 0);

      // Long captures are assembled in Rust, but beautification is rendered
      // in the same canvas pipeline as normal screenshots so padding,
      // background, rounded corners, shadow and window header match exactly.
      const finalCanvas = renderBeautifiedCanvas(sourceCanvas, beautifyConfig);
      const finalCtx = finalCanvas.getContext('2d');
      if (!finalCtx) throw new Error('无法读取长截图像素');
      const finalPixels = finalCtx.getImageData(
        0,
        0,
        finalCanvas.width,
        finalCanvas.height,
      ).data;
      const result = await finishLongCapture(action, finalCanvas.width, finalCanvas.height, finalPixels);
      setIsLongCapturing(false);
      if (action === 'save' && result?.path) {
        await appToast.save(result.path, '长截图已保存');
      }
      onFinished();
    } catch (err) {
      appToast.error('导出长截图失败', String(err));
    } finally {
      scrollStepLoadingRef.current = false;
      setBusy(null);
    }
  };

  const cancelLongCaptureFlow = async () => {
    try {
      await cancelLongCapture();
    } catch (err) {
      console.error(err);
    }
    setIsLongCapturing(false);
    setLongCapturePreview(null);
    setStatus('已取消长截图');
    render();
  };

  useEffect(() => {
    let timer: any = null;
    if (isLongCapturing) {
      // Sync manual scrolling by user
      timer = setInterval(async () => {
        if (scrollStepLoadingRef.current) return;
        scrollStepLoadingRef.current = true;
        try {
          const res = await longCaptureManualFrame();
          if (res.deltaY > 0) {
            setLongCaptureHeight(res.totalHeight);
            setLongCaptureFrames(res.frameCount);
            const preview = await getLongCapturePreview(180);
            if (preview) {
              setLongCapturePreview(preview);
            }
          }
        } catch {
          // Ignore transient capture errors
        } finally {
          scrollStepLoadingRef.current = false;
        }
      }, 250);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isLongCapturing]);

  const enterRecordingPrep = () => {
    if (isRecording || recordingExportState) return;
    if (isRecordingPrep) {
      setIsRecordingPrep(false);
      return;
    }
    if (editing !== null) commitEditingText();
    setIsRecordingPrep(true);
    setStatus('已进入录制准备状态，可调整参数后点击“开始录制”');
  };

  const startRecordingFlow = async () => {
    if (!selection || recordingActionRef.current || isRecording || recordingExportState) return;
    recordingActionRef.current = true;
    if (editing !== null) commitEditingText();
    capacityToastRef.current = false;
    setBusy('正在启动屏幕录制...');
    logDiagnostic(
      'info',
      'recording.ui',
      'start requested; session=' + sessionId +
        '; rect=' + [selection.x, selection.y, selection.width, selection.height].join('x') +
        '; fps=' + recordingFps +
        '; cursor=' + recordCursor,
    );
    try {
      const res = await startScreenRecording(sessionId, selection, recordingFps, recordCursor);
      logDiagnostic(
        'info',
        'recording.ui',
        'start completed; frames=' + res.frameCount +
          '; size=' + res.width + 'x' + res.height +
          '; state=' + res.state,
      );
      setIsRecordingPrep(false);
      setIsRecording(true);
      setRecordingStatus(res);
      setStatus('屏幕录制中：点击完成或按回车结束录制');
    } catch (err) {
      const detail = describeError(err);
      logDiagnostic('error', 'recording.ui', 'start failed: ' + detail.message, detail.stack);
      appToast.error('启动屏幕录制失败', String(err));
    } finally {
      setBusy(null);
      recordingActionRef.current = false;
    }
  };

  const togglePauseRecording = async () => {
    if (!isRecording) return;
    try {
      if (recordingStatus?.state === 'paused') {
        const res = await resumeScreenRecording();
        setRecordingStatus(res);
      } else {
        const res = await pauseScreenRecording();
        setRecordingStatus(res);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const stopRecordingFlow = async () => {
    if (!isRecording || recordingActionRef.current) return;
    recordingActionRef.current = true;
    setBusy('正在处理录屏数据...');
    logDiagnostic('info', 'recording.ui', 'stop requested');
    try {
      const finalStatus = await stopScreenRecording();
      logDiagnostic(
        'info',
        'recording.ui',
        'stop completed; frames=' + finalStatus.frameCount +
          '; durationMs=' + finalStatus.durationMs +
          '; size=' + finalStatus.width + 'x' + finalStatus.height +
          '; state=' + finalStatus.state,
      );
      setIsRecording(false);
      setRecordingStatus(null);

      if (finalStatus.frameCount === 0) {
        await cancelScreenRecording().catch(() => {});
        appToast.error('未录制到有效帧，请重新录制');
        setIsRecording(false);
        setIsRecordingPrep(false);
        setRecordingStatus(null);
        setRecordingExportState(null);
        setExportIsPlaying(false);
        setExportCurrentIndex(0);
        setIsPreviewLoading(false);
        setExportProgress(0);
        setStatus('未录制到有效帧，已返回截图选区');
        render();
        return;
      }

      setRecordingExportState({
        status: finalStatus,
        frames: [],
      });
      setExportCurrentIndex(0);
      setExportIsPlaying(false);
      setStatus('录制完成，点击播放后加载预览；导出时将读取原始帧');
    } catch (err) {
      const detail = describeError(err);
      console.error('stopRecordingFlow error', err);
      logDiagnostic('error', 'recording.ui', 'stop failed: ' + detail.message, detail.stack);
      appToast.error('处理录屏数据失败', String(err));
      setIsRecording(false);
      setRecordingStatus(null);
    } finally {
      setBusy(null);
      recordingActionRef.current = false;
    }
  };

  const cancelRecordingFlow = async () => {
    if (recordingActionRef.current) return;
    recordingActionRef.current = true;
    logDiagnostic('info', 'recording.ui', 'cancel requested');
    try {
      await cancelScreenRecording();
      logDiagnostic('info', 'recording.ui', 'cancel completed');
    } catch (err) {
      const detail = describeError(err);
      logDiagnostic('error', 'recording.ui', 'cancel failed: ' + detail.message, detail.stack);
      console.error(err);
    } finally {
      setIsRecording(false);
      setIsRecordingPrep(false);
      setRecordingStatus(null);
      setRecordingExportState(null);
      setExportIsPlaying(false);
      setExportCurrentIndex(0);
      setIsPreviewLoading(false);
      setExportProgress(0);
      recordingActionRef.current = false;
      setStatus('已取消录制，已返回截图选区');
      render();
    }
  };

  const finishAndCloseRecording = async () => {
    if (isExporting || isPreviewLoading || exportActionRef.current || previewLoadingRef.current) return;
    logDiagnostic('info', 'recording.ui', 'discard requested');
    try {
      await cancelScreenRecording();
      logDiagnostic('info', 'recording.ui', 'discard completed');
    } catch (err) {
      const detail = describeError(err);
      logDiagnostic('error', 'recording.ui', 'discard failed: ' + detail.message, detail.stack);
      console.error('Failed to discard recording', err);
    } finally {
      setRecordingExportState(null);
      setExportIsPlaying(false);
      setExportCurrentIndex(0);
      setIsPreviewLoading(false);
      setExportProgress(0);
      setIsRecording(false);
      setIsRecordingPrep(false);
      setRecordingStatus(null);
      setStatus('已退出录屏，已返回截图选区');
      render();
    }
  };

  const loadRecordingPreview = async () => {
    if (!recordingExportState || recordingExportState.status.frameCount === 0 || previewLoadingRef.current) {
      return false;
    }
    if (recordingExportState.frames.length > 0) return true;

    logDiagnostic(
      'info',
      'preview.ui',
      'preview requested; sourceFrames=' + recordingExportState.status.frameCount +
        '; sourceSize=' + recordingExportState.status.width + 'x' + recordingExportState.status.height,
    );
    previewCancelRef.current = false;
    previewLoadingRef.current = true;
    setIsPreviewLoading(true);
    setExportProgress(5);
    setStatus('正在准备录制预览...');
    try {
      // Preview at the native recording resolution. The backend may sample
      // fewer frames to respect its memory budget, but it no longer shrinks
      // the spatial dimensions of each frame.
      const maxDim = Math.max(
        16,
        recordingExportState.status.width,
        recordingExportState.status.height,
      );
      const previewInfo = await getRecordingPreviewInfo(maxDim);
      logDiagnostic(
        'info',
        'preview.ui',
        'preview info received; frames=' + previewInfo.frameCount +
          '; size=' + previewInfo.width + 'x' + previewInfo.height,
      );
      if (previewCancelRef.current) {
        setStatus('已取消预览');
        return false;
      }
      setExportProgress(20);
      if (previewInfo.frameCount === 0) {
        throw new Error('没有可预览的录制帧');
      }

      setStatus('正在生成预览帧...');
      const previewBuffer = await getRecordingPreviewPixels(maxDim);
      logDiagnostic(
        'info',
        'preview.ui',
        'preview pixels received; bytes=' + previewBuffer.byteLength,
      );
      if (previewCancelRef.current) {
        setStatus('已取消预览');
        return false;
      }
      setExportProgress(85);
      const previewByteLen = previewInfo.width * previewInfo.height * 4;
      const availableFrames = Math.min(
        previewInfo.frameCount,
        Math.floor(previewBuffer.byteLength / previewByteLen),
      );
      if (availableFrames === 0) throw new Error('预览帧数据为空');

      const frames: ImageData[] = [];
      for (let i = 0; i < availableFrames; i++) {
        const offset = i * previewByteLen;
        const frameView = new Uint8ClampedArray(previewBuffer, offset, previewByteLen);
        frames.push(new ImageData(frameView, previewInfo.width, previewInfo.height));
      }

      setRecordingExportState((current) => current
        ? { ...current, previewWidth: previewInfo.width, previewHeight: previewInfo.height, frames }
        : current);
      setExportCurrentIndex(0);
      setExportProgress(100);
      setStatus('预览已准备完成');
      logDiagnostic('info', 'preview.ui', 'preview ready; frames=' + availableFrames);
      return true;
    } catch (err) {
      const detail = describeError(err);
      console.error('loadRecordingPreview error', err);
      logDiagnostic('error', 'preview.ui', 'preview failed: ' + detail.message, detail.stack);
      if (previewCancelRef.current) {
        setStatus('已取消预览');
      } else {
        appToast.error('加载录制预览失败', String(err));
        setStatus('预览加载失败，可直接导出录制文件');
      }
      return false;
    } finally {
      previewLoadingRef.current = false;
      previewCancelRef.current = false;
      setIsPreviewLoading(false);
      window.setTimeout(() => setExportProgress(0), 500);
    }
  };

  const toggleExportPlayback = async () => {
    if (isExporting || isPreviewLoading) return;
    if (!recordingExportState || recordingExportState.status.frameCount === 0) return;
    if (recordingExportState.frames.length === 0) {
      const loaded = await loadRecordingPreview();
      if (!loaded) return;
    }
    setExportIsPlaying((playing) => !playing);
  };

  const cancelExportFlow = async () => {
    if (exportActionRef.current) {
      exportCancelRef.current = true;
      setStatus('正在取消导出...');
      try {
        await cancelRecordingExport();
      } catch (err) {
        console.error('cancelRecordingExport error', err);
      }
      return;
    }
    if (previewLoadingRef.current) {
      previewCancelRef.current = true;
      setStatus('正在取消预览...');
    }
  };

  const handleToolbarExport = async (action: 'save' | 'save_as' | 'copy') => {
    if (!recordingExportState || recordingExportState.status.frameCount === 0 || isExporting || exportActionRef.current) return;
    exportActionRef.current = true;
    exportCancelRef.current = false;
    setExportIsPlaying(false);
    setIsExporting(true);
    setExportProgress(5);
    logDiagnostic('info', 'export.ui', `export requested; format=${exportFormat}; action=${action}`);

    try {
      let chosenPath: string | undefined = undefined;
      if (action === 'save_as') {
        setStatus('请选择保存位置...');
        const picked = await pickRecordingSavePath(exportFormat);
        if (!picked) {
          setStatus('已取消选择保存位置，可继续预览或导出');
          logDiagnostic('info', 'export.ui', 'save dialog cancelled');
          return;
        }
        chosenPath = picked;
      }

      if (exportCancelRef.current) throw new Error('录制导出已取消');

      if (exportFormat === 'gif') {
        setStatus('正在生成并调色 GIF 动图...');
        setExportProgress(5);
        await exportRecordingGif(
          {
            speed: exportSpeed,
            quality: exportGifQuality === 'high' ? 8 : 16,
            scale: exportGifScale,
          },
          action,
          chosenPath
        );
        if (exportCancelRef.current) throw new Error('录制导出已取消');
        setExportProgress(100);
      } else {
        setStatus(`正在硬件编码 ${exportFormat.toUpperCase()} 视频...`);
        const exportFunc = exportFormat === 'mp4' ? encodeFramesToMp4 : encodeFramesToWebm;
        const totalFrames = recordingExportState.status.frameCount;
        let lastProgressAt = 0;
        const videoBytes = await exportFunc(
          async (index: number) => {
            const frameBuf = await getRecordingFrame(index);
            return new Uint8ClampedArray(frameBuf);
          },
          recordingExportState.status.width,
          recordingExportState.status.height,
          {
            fps: recordingExportState.status.fps,
            speed: exportSpeed,
            quality: exportVideoQuality,
            frameCount: totalFrames,
            isCancelled: () => exportCancelRef.current,
            onProgress: (ratio) => {
              const now = Date.now();
              if (ratio < 1 && now - lastProgressAt < 100) return;
              lastProgressAt = now;
              setExportProgress(Math.round(ratio * 85));
              setStatus(`正在硬件编码 ${exportFormat.toUpperCase()}: ${Math.round(ratio * 100)}%`);
            },
          }
        );

        if (exportCancelRef.current) throw new Error('录制导出已取消');
        setStatus('正在写入媒体文件...');
        setExportProgress(95);
        await saveRecordingVideo(exportFormat, videoBytes, action, chosenPath);
        if (exportCancelRef.current) throw new Error('录制导出已取消');
        setExportProgress(100);
      }

      logDiagnostic('info', 'export.ui', 'export completed');
      setStatus(action === 'copy' ? '录制文件已复制，可继续预览或导出' : '录制文件已保存，可继续预览或导出');
    } catch (err) {
      console.error('Export error', err);
      const detail = describeError(err);
      logDiagnostic('error', 'export.ui', detail.message, detail.stack);
      if (exportCancelRef.current || String(err).includes('录制导出已取消')) {
        setStatus('已取消导出');
      } else {
        appToast.error('导出录制文件失败', String(err));
      }
    } finally {
      setIsExporting(false);
      exportActionRef.current = false;
      exportCancelRef.current = false;
      setExportProgress(0);
    }
  };

  // Poll recording status while recording
  useEffect(() => {
    if (!isRecording) return;
    const timer = setInterval(async () => {
      try {
        const status = await getScreenRecordingStatus();
        recordingPollErrorRef.current = false;
        setRecordingStatus(status);
        if (status.capacityReached) {
          if (!capacityToastRef.current) {
            appToast.info('录制缓存已达上限', '已自动暂停录制，请点击完成并导出', 3500);
            capacityToastRef.current = true;
          }
        } else {
          capacityToastRef.current = false;
        }
      } catch (err) {
        console.error('getScreenRecordingStatus error', err);
        if (!recordingPollErrorRef.current) {
          const detail = describeError(err);
          logDiagnostic('warn', 'recording.ui', 'status poll failed: ' + detail.message, detail.stack);
          recordingPollErrorRef.current = true;
        }
      }
    }, 200);
    return () => clearInterval(timer);
  }, [isRecording]);

  // Playback timer for recording preview
  useEffect(() => {
    if (!recordingExportState || !exportIsPlaying || recordingExportState.frames.length <= 1) return;
    // Preview frames may be sampled to keep the IPC payload bounded. Derive
    // playback timing from the recording duration rather than source FPS.
    const intervalMs = Math.max(
      16,
      Math.round(
        recordingExportState.status.durationMs /
          recordingExportState.frames.length /
          exportSpeed,
      ),
    );
    const timer = setInterval(() => {
      setExportCurrentIndex((idx) => (idx + 1) % recordingExportState.frames.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [recordingExportState, exportIsPlaying, exportSpeed]);

  useEffect(() => {
    if (recordingExportState) {
      render();
    }
  }, [recordingExportState, exportCurrentIndex, render]);

  // Keyboard shortcut handlers (including PixPin-style 'C' color picker)
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === 'TEXTAREA') return;

      if (isRecordingPrep) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setIsRecordingPrep(false);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void startRecordingFlow();
          return;
        }
        return;
      }

      if (isRecording) {
        if (event.key === 'Escape') {
          event.preventDefault();
          void cancelRecordingFlow();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          void stopRecordingFlow();
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          void togglePauseRecording();
          return;
        }
        return;
      }

      if (recordingExportState) {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (isExporting || isPreviewLoading) {
            void cancelExportFlow();
          } else {
            void finishAndCloseRecording();
          }
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          void toggleExportPlayback();
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void handleToolbarExport('save');
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          void handleToolbarExport('save');
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === 'c') {
          event.preventDefault();
          void handleToolbarExport('copy');
          return;
        }
        return;
      }

      if (isLongCapturing) {
        if (event.key === 'Escape') {
          event.preventDefault();
          void cancelLongCaptureFlow();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          void completeLongCaptureFlow('copy');
          return;
        }
        if (event.key === ' ' || event.key === 'ArrowDown' || event.key === 'PageDown') {
          event.preventDefault();
          void triggerLongCaptureStep(-1);
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void completeLongCaptureFlow('save');
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === 'c') {
          event.preventDefault();
          void completeLongCaptureFlow('copy');
          return;
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        if (ocrMode) {
          exitOcrMode();
        } else if (ocrLoading) {
          void cancel();
        } else if (selectedMarkId !== null) {
          setSelectedMarkId(null);
          setStatus('已取消选中');
        } else if (tool !== 'select') {
          if (editing !== null) commitEditingText();
          setTool('select');
        } else {
          cancel();
        }
      } else if (
        isLoupeActive() &&
        !ocrInteractionLocked &&
        (event.key === 'c' || event.key === 'C') &&
        hoverColor &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        // Copy color under cursor (PixPin feature)
        event.preventDefault();
        const copyVal = event.shiftKey ? hoverColor.rgb : hoverColor.hex;
        navigator.clipboard.writeText(copyVal);
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (!ocrInteractionLocked) redo();
      } else if (event.ctrlKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (!ocrInteractionLocked) undo();
      } else if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!ocrInteractionLocked) {
          exportSelection('save');
        }
      } else if (event.ctrlKey && event.key.toLowerCase() === 'c' && selection) {
        event.preventDefault();
        if (ocrMode) {
          if (selectedOcrText) {
            void copySelectedOcrText(true);
          } else if (ocrData?.fullText) {
            void copyAllOcrText(true);
          }
        } else {
          exportSelection('copy');
        }
      } else if (selection && event.key.toLowerCase() === 'p') {
        if (!ocrInteractionLocked) {
          event.preventDefault();
          exportSelection('pin');
        }
      } else if (selection && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (!ocrInteractionLocked) {
          void runOcrExtract();
        }
      } else if (selection && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        if (!ocrInteractionLocked && !isLongCapturing) {
          void startLongCaptureFlow();
        }
      } else if (selection && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        if (!ocrInteractionLocked && !isLongCapturing && !isRecording && !recordingExportState) {
          enterRecordingPrep();
        }
      } else if (ocrMode && event.key === 'Enter') {
        event.preventDefault();
        if (selectedOcrText) {
          void copySelectedOcrText(true);
        } else if (ocrData?.fullText) {
          void copyAllOcrText(true);
        }
      } else if (selection && !event.ctrlKey && !event.metaKey && !event.altKey && !ocrInteractionLocked) {
        const key = event.key.toLowerCase();
        if (key === 't') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          setTool(t => (t === 'text' ? 'select' : 'text'));
        } else if (key === 'r') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          if (tool === 'rectangle' || tool === 'ellipse') {
            setTool('select');
          } else {
            setTool(activeShapeMode);
          }
        } else if (key === 'e') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          if (tool === 'ellipse') {
            setTool('select');
          } else {
            setActiveShapeMode('ellipse');
            setTool('ellipse');
          }
        } else if (key === 'a') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          if (tool === 'arrow') {
            setTool('select');
          } else {
            setActiveDrawMode('arrow');
            setTool('arrow');
          }
        } else if (key === 'b' || key === 'h') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          if (tool === 'brush') {
            setTool('select');
          } else {
            setActiveDrawMode('brush');
            setTool('brush');
          }
        } else if (key === 's') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          if (tool === 'step') {
            setTool('select');
          } else {
            setActiveDrawMode('step');
            setTool('step');
          }
        } else if (key === 'm') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          if (tool === 'mosaic' || tool === 'blur') {
            setTool('select');
          } else {
            setTool(activeObfuscateMode);
          }
        } else if (key === 'g') {
          event.preventDefault();
          if (editing !== null) commitEditingText();
          if (tool === 'beautify') {
            setTool('select');
          } else {
            if (!beautifyConfig.enabled) {
              setBeautifyConfig(applyPreset('classic'));
            }
            setTool('beautify');
          }
        }
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedMarkId !== null) {
        event.preventDefault();
        deleteMark(selectedMarkId);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  if (error) {
    return (
      <div className="fatal-state">
        <Typography.Title heading={4}>截图加载失败</Typography.Title>
        <Typography.Text>{error}</Typography.Text>
        <Button onClick={cancel}>关闭</Button>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="loading-state">
        <Spin size="large" />
        <Typography.Text>正在准备选区…</Typography.Text>
      </div>
    );
  }

  const displaySelection = selection ?? draft;

  return (
    <main className="overlay-root" style={isLongCapturing ? { background: 'transparent' } : undefined}>
      <canvas
        ref={canvasRef}
        className="capture-canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => {
          if (ocrInteractionLocked) {
            interactionRef.current = null;
            return;
          }
          finishInteraction(toImagePoint(event));
          if (editing !== null) {
            requestAnimationFrame(() => textareaRef.current?.focus());
          }
        }}
        onPointerCancel={() => {
          interactionRef.current = null;
          setDraft(null);
          setDraftArrow(null);
          setDraftBrushPoints(null);
          setLoupePoint(null);
          setHoverColor(null);
        }}
        onPointerLeave={() => {
          if (!interactionRef.current) {
            setLoupePoint(null);
            setHoverColor(null);
          }
        }}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />

      {/* PixPin-style Magnifier & Color Picker Loupe */}
      {loupePoint && hoverColor && !busy && isLoupeActive() && (() => {
        const bounds = getViewportBounds();
        const size = manifestRef.current || { width: bounds.width, height: bounds.height };
        const cursorX = bounds.left + (loupePoint.x * bounds.width) / size.width;
        const cursorY = bounds.top + (loupePoint.y * bounds.height) / size.height;
        const LOUPE_WIDTH = 136;
        const LOUPE_HEIGHT = draft ? 230 : 205;
        const OFFSET = 20;
        let loupeX = cursorX + OFFSET;
        let loupeY = cursorY + OFFSET;
        if (loupeX + LOUPE_WIDTH > bounds.width - 8) {
          loupeX = cursorX - LOUPE_WIDTH - OFFSET;
        }
        if (loupeY + LOUPE_HEIGHT > bounds.height - 8) {
          loupeY = cursorY - LOUPE_HEIGHT - OFFSET;
        }
        loupeX = Math.max(8, Math.min(bounds.width - LOUPE_WIDTH - 8, loupeX));
        loupeY = Math.max(8, Math.min(bounds.height - LOUPE_HEIGHT - 8, loupeY));
        return (
          <div
            className="pixpin-loupe"
            style={{
              left: `${Math.round(loupeX)}px`,
              top: `${Math.round(loupeY)}px`,
            }}
          >
            <canvas ref={loupeCanvasRef} width={120} height={120} className="loupe-canvas" />
            <div className="loupe-info">
              <div className="loupe-color-row">
                <span className="loupe-swatch" style={{ background: hoverColor.hex }} />
                <span className="loupe-hex">{hoverColor.hex}</span>
              </div>
              <div className="loupe-rgb">{hoverColor.rgb}</div>
              <div className="loupe-coord">
                POS: {Math.round(loupePoint.x)}, {Math.round(loupePoint.y)}
              </div>
              {draft && (
                <div className="loupe-size-row">
                  选区: {Math.round(draft.width)} × {Math.round(draft.height)}
                </div>
              )}
              <div className="loupe-hint">按 C 复制 HEX · Shift+C 复制 RGB</div>
            </div>
          </div>
        );
      })()}

      {/* Smart Window Snapping Badge */}
      {!selection && !draft && hoveredWindow && !busy && (() => {
        const bounds = getViewportBounds();
        const winCss = toCssRect(hoveredWindow);
        const isNearTop = winCss.y < 36;
        const badgeY = isNearTop ? winCss.y + 8 : winCss.y - 32;
        const badgeX = Math.max(8, Math.min(bounds.width - 320, winCss.x + 8));
        return (
          <div
            className="snapped-window-badge"
            style={{
              left: `${Math.round(badgeX)}px`,
              top: `${Math.round(badgeY)}px`,
            }}
          >
            <span className="snapped-window-size">
              {hoveredWindow.width} × {hoveredWindow.height}
            </span>
            {hoveredWindow.title && (
              <span className="snapped-window-title" title={hoveredWindow.title}>
                {hoveredWindow.title}
              </span>
            )}
            <span className="snapped-window-hint">单击选取窗口</span>
          </div>
        );
      })()}

      {/* Interactive OCR Extraction Layer */}
      {ocrMode && ocrData && selection && manifest && (() => {
        const selCss = toCssRect(selection);
        const rect = cropRect(selection, manifest);
        let layerX = selCss.x;
        let layerY = selCss.y;
        let layerW = selCss.width;
        let layerH = selCss.height;

        return (
          <div
            ref={ocrLayerRef}
            className="overlay-ocr-layer"
            style={{
              left: `${layerX}px`,
              top: `${layerY}px`,
              width: `${layerW}px`,
              height: `${layerH}px`,
            }}
          >
            {ocrData.lines.map((line, idx) => {
              const leftPct = (line.rect[0] / rect.width) * 100;
              const topPct = (line.rect[1] / rect.height) * 100;
              const widthPct = (line.rect[2] / rect.width) * 100;
              const heightPct = (line.rect[3] / rect.height) * 100;
              const lineH = (line.rect[3] / rect.height) * layerH;
              return (
                <div
                  key={idx}
                  className="overlay-ocr-line"
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    width: `${widthPct}%`,
                    height: `${heightPct}%`,
                    fontSize: `${Math.max(12, lineH * 0.82)}px`,
                    lineHeight: `${lineH}px`,
                  }}
                  title="按住鼠标左键可划选文字复制"
                >
                  {line.text}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Floating Copy Action Pill when text is selected */}
      {ocrMode && selectedOcrText && ocrSelectionPos && (
        <div
          className="overlay-ocr-floating-pill"
          style={{ left: `${ocrSelectionPos.x}px`, top: `${ocrSelectionPos.y}px` }}
          onPointerDown={e => e.stopPropagation()}
        >
          <button
            type="button"
            className="overlay-ocr-floating-btn"
            onClick={e => {
              e.stopPropagation();
              void copySelectedOcrText(true);
            }}
            title="复制选中的文字并完成截图 (Ctrl+C)"
          >
            <IconCopy size="small" />
            <span>复制文字</span>
          </button>
          <button
            type="button"
            className="overlay-ocr-floating-btn-secondary"
            onClick={e => {
              e.stopPropagation();
              void copySelectedOcrText(false);
            }}
            title="仅复制文字到剪贴板，不退出截图"
          >
            仅复制
          </button>
        </div>
      )}

      {/* Pixel-perfect Size Indicator HUD */}
      {displaySelection && !busy && (() => {
        const bounds = getViewportBounds();
        const selCss = toCssRect(displaySelection);
        const pad = beautifyConfig.enabled ? Math.max(0, beautifyConfig.padding) : 0;
        const headerH = beautifyConfig.enabled && beautifyConfig.windowHeader ? 32 : 0;
        const topEdge = selCss.y - headerH - pad;
        const leftEdge = selCss.x - pad;

        const isNearTop = topEdge < 32;
        const hudY = isNearTop ? Math.max(6, topEdge + 6) : topEdge - 28;
        const hudX = Math.max(8, Math.min(bounds.width - 130, leftEdge));

        const dims = beautifyConfig.enabled
          ? calculateBeautifiedDimensions(displaySelection.width, displaySelection.height, beautifyConfig)
          : { width: displaySelection.width, height: displaySelection.height };

        return (
          <div className="selection-hud-pill" style={{ left: `${Math.round(hudX)}px`, top: `${Math.round(hudY)}px` }}>
            <span className="hud-dim">{Math.round(dims.width)}</span>
            <span className="hud-sep">×</span>
            <span className="hud-dim">{Math.round(dims.height)}</span>
            {ocrMode && <span className="hud-sep">· 提取模式</span>}
          </div>
        );
      })()}

      {/* Pixel-perfect Toolbar bottom-aligned with selection */}
      {selection && !busy && (() => {
        const bounds = getViewportBounds();
        const selCss = toCssRect(selection);
        const pad = beautifyConfig.enabled ? Math.max(0, beautifyConfig.padding) : 0;
        const selRight = selCss.x + selCss.width + pad;
        const selBottom = selCss.y + selCss.height + pad;

        const isOcr = ocrMode;
        const defaultWidth = isOcr ? 210 : recordingExportState ? 480 : (tool !== 'select' ? 620 : 580);
        const tbWidth = (isOcr ? 210 : toolbarContainerRef.current?.offsetWidth || toolbarSize.width) || defaultWidth;
        const tbHeight = toolbarContainerRef.current?.offsetHeight || toolbarSize.height || (tool !== 'select' ? 76 : 40);
        const GAP = 4;

        // Horizontal: right-aligned with selection box
        const isLeftClamped = selRight - tbWidth < 8;
        const rightOffset = Math.max(8, bounds.width - selRight);
        let tbX = selRight - tbWidth;
        if (tbX < 8) {
          tbX = Math.max(8, Math.min(selCss.x, bounds.width - tbWidth - 8));
        } else if (tbX + tbWidth > bounds.width - 8) {
          tbX = bounds.width - tbWidth - 8;
        }

        // Vertical: aligned directly with the bottom of the selection box
        let tbY = selBottom + GAP;
        const topEdge = selCss.y - (beautifyConfig.enabled && beautifyConfig.windowHeader ? 32 : 0) - pad;
        if (isLongCapturing) {
          if (tbY + tbHeight > bounds.height - 6) {
            tbY = Math.max(6, topEdge - tbHeight - GAP);
          }
        } else if (tbY + tbHeight > bounds.height - 6) {
          // If near or past screen bottom, keep it at the BOTTOM inside the selection
          if (selCss.height >= tbHeight + 12) {
            tbY = selBottom - tbHeight - GAP;
          } else if (topEdge >= tbHeight + GAP + 6) {
            tbY = topEdge - tbHeight - GAP;
          } else {
            tbY = Math.max(6, bounds.height - tbHeight - 6);
          }
        }

        const positionStyle: React.CSSProperties = isLeftClamped
          ? { left: `${Math.round(tbX)}px`, top: `${Math.round(tbY)}px` }
          : { right: `${Math.round(rightOffset)}px`, top: `${Math.round(tbY)}px` };

        return (
          <div
            ref={toolbarContainerRef}
            className="overlay-toolbar-container"
            style={positionStyle}
          >
            {ocrMode ? (
              <div className="overlay-toolbar">
                <ToolbarButton
                  icon={
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
                    </svg>
                  }
                  label="全部复制"
                  hint="复制全部提取文本"
                  onClick={() => void copyAllOcrText(true)}
                />
                <span className="toolbar-divider" />
                <ToolbarButton
                  icon={
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 14 4 9 9 4" />
                      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                    </svg>
                  }
                  label="退出提取"
                  hint="Esc"
                  onClick={exitOcrMode}
                />
                <Tooltip content="取消截图 (Esc)">
                  <button
                    type="button"
                    className="tb-icon-btn tb-close-btn"
                    onClick={cancel}
                    aria-label="取消截图"
                  >
                    <IconClose size="small" />
                  </button>
                </Tooltip>
              </div>
            ) : recordingExportState ? (
              <div className="recording-export-container">
                {(isPreviewLoading || isExporting) && (
                  <div className="recording-export-progress-toolbar" aria-live="polite">
                    <span className="rec-export-progress-title">
                      {isPreviewLoading
                        ? '正在准备预览'
                        : `正在导出 ${exportFormat.toUpperCase()}`}
                    </span>
                    <div className="rec-export-progress-track">
                      <div
                        className="rec-export-progress-value"
                        style={{ width: `${Math.max(4, exportProgress)}%` }}
                      />
                    </div>
                    <span className="rec-export-progress-label">
                      {Math.round(exportProgress)}%
                    </span>
                    <Tooltip content={isPreviewLoading ? '取消预览' : '取消导出'}>
                      <button
                        type="button"
                        className="tb-icon-btn tb-close-btn"
                        onClick={() => void cancelExportFlow()}
                        aria-label={isPreviewLoading ? '取消预览' : '取消导出'}
                      >
                        <IconClose size="small" />
                      </button>
                    </Tooltip>
                  </div>
                )}

                {/* Row 1: Timeline & Playback Controls */}
                <div className="overlay-toolbar recording-export-toolbar">
                  <ToolbarButton
                    icon={
                      exportIsPlaying ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <IconPlay />
                      )
                    }
                    label={exportIsPlaying ? '暂停' : '播放'}
                    hint="空格"
                    onClick={() => void toggleExportPlayback()}
                    disabled={isExporting || isPreviewLoading}
                  />

                  <div className="rec-timeline-row">
                    {(() => {
                      const timelineFrames = recordingExportState.frames.length > 0
                        ? recordingExportState.frames.length
                        : recordingExportState.status.frameCount;
                      return (
                        <>
                    <span className="rec-time-text">
                      {(
                        ((exportCurrentIndex + 1) /
                          Math.max(1, timelineFrames)) *
                        (recordingExportState.status.durationMs / 1000)
                      ).toFixed(1)}s / {(recordingExportState.status.durationMs / 1000).toFixed(1)}s
                    </span>

                    <div className="rec-scrubber">
                      <Slider
                        min={0}
                        max={Math.max(0, timelineFrames - 1)}
                        value={Math.min(exportCurrentIndex, Math.max(0, timelineFrames - 1))}
                        onChange={(val) => {
                          setExportIsPlaying(false);
                          setExportCurrentIndex(Number(val));
                        }}
                        tooltipVisible={false}
                        disabled={isExporting || isPreviewLoading || recordingExportState.frames.length === 0}
                      />
                    </div>

                    <span className="rec-time-text" style={{ fontSize: '11px', color: 'var(--ps-text-2)' }}>
                      {exportCurrentIndex + 1}/{timelineFrames}帧
                    </span>
                        </>
                      );
                    })()}
                  </div>

                  <span className="toolbar-divider" />

                  <span style={{ fontSize: '11px', color: 'var(--ps-text-2)' }}>倍速:</span>
                  {[0.5, 1.0, 1.5, 2.0].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`rec-speed-pill ${exportSpeed === s ? 'active' : ''}`}
                      onClick={() => setExportSpeed(s)}
                      disabled={isExporting}
                    >
                      {s}x
                    </button>
                  ))}
                </div>

                {/* Row 2: Format & Export Actions */}
                <div className="overlay-toolbar recording-export-toolbar">
                  <span className="rec-badge-pill">EXPORT</span>

                  <div className="rec-format-toggle">
                    {(['gif', 'mp4', 'webm'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        className={`rec-format-btn ${exportFormat === fmt ? 'active' : ''}`}
                        onClick={() => setExportFormat(fmt)}
                        disabled={isExporting}
                      >
                        {fmt.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  {exportFormat === 'gif' && (
                    <>
                      <span className="toolbar-divider" />
                      <span style={{ fontSize: '11px', color: 'var(--ps-text-2)' }}>质量:</span>
                      <button
                        type="button"
                        className={`rec-speed-pill ${exportGifQuality === 'high' ? 'active' : ''}`}
                        onClick={() => setExportGifQuality('high')}
                        disabled={isExporting}
                      >
                        高质量
                      </button>
                      <button
                        type="button"
                        className={`rec-speed-pill ${exportGifQuality === 'standard' ? 'active' : ''}`}
                        onClick={() => setExportGifQuality('standard')}
                        disabled={isExporting}
                      >
                        标准
                      </button>

                      <span className="toolbar-divider" />
                      <span style={{ fontSize: '11px', color: 'var(--ps-text-2)' }}>尺寸:</span>
                      {[1.0, 0.75, 0.5].map((scale) => (
                        <button
                          key={scale}
                          type="button"
                          className={`rec-speed-pill ${exportGifScale === scale ? 'active' : ''}`}
                          onClick={() => setExportGifScale(scale)}
                          disabled={isExporting}
                        >
                          {scale === 1.0 ? '100%' : `${scale * 100}%`}
                        </button>
                      ))}
                    </>
                  )}

                  {exportFormat !== 'gif' && (
                    <>
                      <span className="toolbar-divider" />
                      <span style={{ fontSize: '11px', color: 'var(--ps-text-2)' }}>画质:</span>
                      {(['high', 'medium'] as const).map((q) => (
                        <button
                          key={q}
                          type="button"
                          className={`rec-speed-pill ${exportVideoQuality === q ? 'active' : ''}`}
                          onClick={() => setExportVideoQuality(q)}
                          disabled={isExporting}
                        >
                          {q === 'high' ? '超清' : '标清'}
                        </button>
                      ))}
                    </>
                  )}

                  <span className="toolbar-divider" />

                  <ToolbarButton
                    icon={<IconCopy />}
                    label="复制"
                    hint="Ctrl+C"
                    primary
                    onClick={() => void handleToolbarExport('copy')}
                    disabled={isExporting}
                  />

                  <ToolbarButton
                    icon={<IconFolderOpenStroked />}
                    label="另存为"
                    hint="选择路径"
                    onClick={() => void handleToolbarExport('save_as')}
                    disabled={isExporting}
                  />

                  <ToolbarButton
                    icon={isExporting ? <Spin size="small" /> : <IconSaveStroked />}
                    label={isExporting ? '导出中…' : '保存'}
                    hint="Ctrl+S / 回车"
                    primary
                    onClick={() => void handleToolbarExport('save')}
                    disabled={isExporting}
                  />

                  <Tooltip content="退出录屏 (Esc)">
                    <button
                      type="button"
                      className="tb-icon-btn tb-close-btn"
                      onClick={() => void finishAndCloseRecording()}
                      disabled={isExporting || isPreviewLoading}
                      aria-label="退出录屏"
                    >
                      <IconClose size="small" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ) : isRecordingPrep ? (
              <div className="overlay-toolbar recording-prep-toolbar">
                <span className="rec-prep-badge">REC 准备</span>

                <span style={{ fontSize: '11.5px', color: 'var(--ps-text-1)', padding: '0 4px', whiteSpace: 'nowrap' }}>
                  {Math.round(selection.width)} × {Math.round(selection.height)}
                </span>

                <span className="toolbar-divider" />

                <span style={{ fontSize: '11px', color: 'var(--ps-text-2)' }}>帧率:</span>
                {[15, 24, 30].map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    className={`rec-speed-pill ${recordingFps === fps ? 'active' : ''}`}
                    onClick={() => setRecordingFps(fps)}
                  >
                    {fps} FPS
                  </button>
                ))}

                <span className="toolbar-divider" />

                <button
                  type="button"
                  className={`rec-speed-pill ${recordCursor ? 'active' : ''}`}
                  onClick={() => setRecordCursor((c) => !c)}
                  title="是否在录像中包含鼠标指针"
                >
                  {recordCursor ? '鼠标: 显示' : '鼠标: 隐藏'}
                </button>

                <span className="toolbar-divider" />

                <ToolbarButton
                  icon={
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  }
                  label="开始录制"
                  hint="回车 / 空格"
                  primary
                  onClick={startRecordingFlow}
                  disabled={!!busy || recordingStatus?.capacityReached}
                />

                <Tooltip content="退出录屏模式 (Esc)">
                  <button
                    type="button"
                    className="tb-icon-btn tb-close-btn"
                    onClick={() => setIsRecordingPrep(false)}
                    aria-label="退出录屏模式"
                  >
                    <IconClose size="small" />
                  </button>
                </Tooltip>
              </div>
            ) : isRecording ? (
              <div className="overlay-toolbar recording-toolbar">
                <span
                  className="rec-pulse-dot"
                  style={{
                    background:
                      recordingStatus?.state === 'paused' ? '#eab308' : '#ef4444',
                  }}
                />
                <span className="rec-time-badge">
                  {recordingStatus
                    ? `${Math.floor(recordingStatus.durationMs / 60000)
                        .toString()
                        .padStart(2, '0')}:${(
                        (recordingStatus.durationMs % 60000) /
                        1000
                      )
                        .toFixed(1)
                        .padStart(4, '0')}`
                    : '00:00.0'}
                </span>
                <span className="rec-meta-text">
                  {recordingStatus
                    ? recordingStatus.capacityReached
                      ? `已达缓存上限 · ${recordingStatus.frameCount} 帧，请结束并导出`
                      : `${recordingStatus.frameCount} 帧 · ${recordingStatus.width}×${recordingStatus.height}`
                    : ''}
                </span>
                <span className="toolbar-divider" />
                <ToolbarButton
                  icon={
                    recordingStatus?.state === 'paused' ? (
                      <IconPlay />
                    ) : (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                    )
                  }
                  label={
                    recordingStatus?.state === 'paused' ? '继续' : '暂停'
                  }
                  hint="空格"
                  onClick={togglePauseRecording}
                  disabled={!!busy}
                />
                <ToolbarButton
                  icon={
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                    </svg>
                  }
                  label="完成"
                  hint="回车 / 结束录制"
                  primary
                  onClick={stopRecordingFlow}
                  disabled={!!busy}
                />
                <Tooltip content="取消录制 (Esc)">
                  <button
                    type="button"
                    className="tb-icon-btn tb-close-btn"
                    onClick={cancelRecordingFlow}
                    aria-label="取消录制"
                  >
                    <IconClose size="small" />
                  </button>
                </Tooltip>
              </div>
            ) : isLongCapturing ? (
              <div className="overlay-toolbar long-capture-toolbar">
                <ToolbarButton
                  icon={
                    scrollStepLoading ? (
                      <Spin size="small" />
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14M19 12l-7 7-7-7" />
                      </svg>
                    )
                  }
                  label="向下滚动"
                  hint="↓ / 滚轮 / 空格"
                  primary
                  onClick={() => void triggerLongCaptureStep(-1)}
                  disabled={!!busy || longCaptureIsBottom}
                />
                <span className="toolbar-divider" />
                <span style={{ fontSize: 11.5, color: 'var(--ps-text-1)', padding: '0 8px', whiteSpace: 'nowrap', fontWeight: 500 }}>
                  {longCaptureIsBottom ? '已到页面底部' : `已拼 ${longCaptureFrames} 帧 · ${longCaptureHeight}px`}
                </span>
                <span className="toolbar-divider" />
                <ToolbarButton
                  icon={<IconCopy />}
                  label="复制"
                  hint="Ctrl+C / 回车"
                  primary
                  onClick={() => void completeLongCaptureFlow('copy')}
                  disabled={!!busy}
                />
                <ToolbarButton
                  icon={<IconSaveStroked />}
                  label="保存"
                  hint="Ctrl+S"
                  onClick={() => void completeLongCaptureFlow('save')}
                  disabled={!!busy}
                />
                <Tooltip content="取消长截图 (Esc)">
                  <button
                    type="button"
                    className="tb-icon-btn tb-close-btn"
                    onClick={cancelLongCaptureFlow}
                    aria-label="取消长截图"
                  >
                    <IconClose size="small" />
                  </button>
                </Tooltip>
              </div>
            ) : (
              <div className="overlay-toolbar">
                <ToolbarButton
                  icon={
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
                    </svg>
                  }
                  label="美化"
                  hint="G (截图美化与导出预设)"
                  active={tool === 'beautify'}
                  onClick={() => {
                    if (editing !== null) commitEditingText();
                    if (tool === 'beautify') {
                      setTool('select');
                    } else {
                      if (!beautifyConfig.enabled) {
                        setBeautifyConfig(applyPreset('classic'));
                      }
                      setTool('beautify');
                    }
                  }}
                  disabled={!!busy || ocrLoading}
                />
                <ToolbarButton
                  icon={
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="5" y="2" width="14" height="20" rx="2" />
                      <path d="M12 6v12" />
                      <path d="m8 14 4 4 4-4" />
                    </svg>
                  }
                  label="长截图"
                  hint="L (滚动拼接截取长图)"
                  onClick={startLongCaptureFlow}
                  disabled={!!busy || ocrLoading || isLongCapturing || isRecording}
                />
                <ToolbarButton
                  icon={
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="12" r="4" fill="currentColor" />
                    </svg>
                  }
                  label="录制"
                  hint="V (进入录屏准备)"
                  active={isRecordingPrep}
                  onClick={enterRecordingPrep}
                  disabled={!!busy || ocrLoading || isLongCapturing || isRecording}
                />
                <ToolbarButton
                  icon={
                    ocrLoading ? (
                      <Spin size="small" />
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 7V4h16v3M9 20h6M12 4v16" />
                      </svg>
                    )
                  }
                  label="提取"
                  hint="O (提取文字自由划选)"
                  onClick={runOcrExtract}
                  disabled={!!busy || ocrLoading}
                />

                <span className="toolbar-divider" />

                {(() => {
                  const isDrawActive = tool === 'arrow' || tool === 'brush' || tool === 'step';
                  return (
                    <ToolbarButton
                      icon={
                        activeDrawMode === 'brush' ? (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                          </svg>
                        ) : activeDrawMode === 'step' ? (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                            <circle cx="12" cy="12" r="9" />
                            <text x="12" y="16" fontSize="11" fontWeight="bold" textAnchor="middle" fill="currentColor" stroke="none">1</text>
                          </svg>
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="5" y1="19" x2="19" y2="5" />
                            <polyline points="12 5 19 5 19 12" />
                          </svg>
                        )
                      }
                      label={
                        isDrawActive
                          ? (activeDrawMode === 'brush' ? '画笔' : activeDrawMode === 'step' ? '序号' : '箭头')
                          : '标注'
                      }
                      hint={activeDrawMode === 'brush' ? 'B' : activeDrawMode === 'step' ? 'S' : 'A'}
                      active={isDrawActive}
                      onClick={() => {
                        if (editing !== null) commitEditingText();
                        if (isDrawActive) {
                          setTool('select');
                        } else {
                          setTool(activeDrawMode);
                        }
                      }}
                      disabled={!!busy || ocrLoading}
                    />
                  );
                })()}
                <ToolbarButton
                  icon={<IconFont />}
                  label="文字"
                  hint="T"
                  active={tool === 'text'}
                  onClick={() => {
                    if (editing !== null) {
                      commitEditingText();
                    }
                    setTool(tool === 'text' ? 'select' : 'text');
                  }}
                  disabled={!!busy || ocrLoading}
                />
                <ToolbarButton
                  icon={
                    activeObfuscateMode === 'blur' ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
                      </svg>
                    ) : (
                      <span className="tb-mosaic-icon">▦</span>
                    )
                  }
                  label={activeObfuscateMode === 'blur' ? '模糊' : '马赛克'}
                  hint="M"
                  active={tool === 'mosaic' || tool === 'blur'}
                  onClick={() => {
                    if (editing !== null) commitEditingText();
                    if (tool === 'mosaic' || tool === 'blur') {
                      setTool('select');
                    } else {
                      setTool(activeObfuscateMode);
                    }
                  }}
                  disabled={!!busy || ocrLoading}
                />
                <ToolbarButton
                  icon={
                    activeShapeMode === 'ellipse' ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="12" cy="12" r="9" />
                      </svg>
                    ) : (
                      <IconStop />
                    )
                  }
                  label="图形"
                  hint="R"
                  active={tool === 'rectangle' || tool === 'ellipse'}
                  onClick={() => {
                    if (editing !== null) commitEditingText();
                    if (tool === 'rectangle' || tool === 'ellipse') {
                      setTool('select');
                    } else {
                      setTool(activeShapeMode);
                    }
                  }}
                  disabled={!!busy || ocrLoading}
                />

                <span className="toolbar-divider" />

                <Tooltip content="撤销 (Ctrl+Z)">
                  <button
                    type="button"
                    className="tb-icon-btn"
                    disabled={!past.length || ocrLoading}
                    onClick={undo}
                    aria-label="撤销"
                  >
                    <IconUndo size="small" />
                  </button>
                </Tooltip>
                <Tooltip content="重做 (Ctrl+Shift+Z)">
                  <button
                    type="button"
                    className="tb-icon-btn"
                    disabled={!future.length || ocrLoading}
                    onClick={redo}
                    aria-label="重做"
                  >
                    <IconRedo size="small" />
                  </button>
                </Tooltip>

                <span className="toolbar-divider" />

                <ToolbarButton
                  icon={<IconPin size={13} />}
                  label="钉图"
                  hint="P"
                  onClick={() => exportSelection('pin')}
                  disabled={!!busy || ocrLoading}
                />
                <ToolbarButton
                  icon={<IconSaveStroked />}
                  label="保存"
                  hint="Ctrl+S"
                  onClick={() => exportSelection('save')}
                  disabled={!!busy || ocrLoading}
                />
                <ToolbarButton
                  icon={<IconCopy />}
                  label="复制"
                  hint="Ctrl+C (双击选区)"
                  primary
                  onClick={() => exportSelection('copy')}
                  disabled={!!busy || ocrLoading}
                />

                <Tooltip content="取消 (Esc)">
                  <button
                    type="button"
                    className="tb-icon-btn tb-close-btn"
                    onClick={cancel}
                    aria-label="取消"
                  >
                    <IconClose size="small" />
                  </button>
                </Tooltip>
              </div>
          )}
            {/* Beautify Sub-toolbar */}
            {tool === 'beautify' && !ocrMode && !isLongCapturing && !isRecordingPrep && !isRecording && !recordingExportState && (
              <div className="beautify-subbar">
                <div className="beautify-subbar-row">
                  <span className="beautify-subbar-label">预设:</span>
                  {BEAUTIFY_PRESETS.map(preset => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`style-pill ${beautifyConfig.presetId === preset.id ? 'active' : ''}`}
                      onClick={() => setBeautifyConfig(applyPreset(preset.id))}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <div className="beautify-subbar-row">
                  <span className="beautify-subbar-label">阴影:</span>
                  {SHADOW_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`width-pill ${beautifyConfig.shadow === opt.value ? 'active' : ''}`}
                      onClick={() =>
                        setBeautifyConfig(cfg => ({
                          ...cfg,
                          enabled: true,
                          shadow: opt.value,
                          presetId: 'custom',
                        }))
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                  <span className="subbar-divider" />
                  <button
                    type="button"
                    className={`style-pill ${beautifyConfig.windowHeader ? 'active' : ''}`}
                    onClick={() =>
                      setBeautifyConfig(cfg => ({
                        ...cfg,
                        enabled: true,
                        windowHeader: !cfg.windowHeader,
                        presetId: 'custom',
                      }))
                    }
                  >
                    {beautifyConfig.windowHeader ? '窗口栏：开' : '窗口栏：关'}
                  </button>
                </div>
              </div>
            )}

            {/* PixPin-style Annotation Sub-toolbar */}
            {(() => {
              const selectedMark = marks.find(m => m.id === selectedMarkId);
              const isShapeContext = (tool === 'rectangle' || tool === 'ellipse') || (selectedMark && (selectedMark.kind === 'rectangle' || selectedMark.kind === 'ellipse'));
              const isDrawContext = (tool === 'arrow' || tool === 'brush' || tool === 'step') || (selectedMark && (selectedMark.kind === 'arrow' || selectedMark.kind === 'brush' || selectedMark.kind === 'step'));
              const isTextContext = tool === 'text' || editing !== null || (selectedMark && selectedMark.kind === 'text');
              const isStepContext = tool === 'step' || (selectedMark && selectedMark.kind === 'step');
              const isObfuscateContext = tool === 'blur' || tool === 'mosaic' || (selectedMark && (selectedMark.kind === 'blur' || selectedMark.kind === 'mosaic'));
              const showSubbar = (tool !== 'select' && tool !== 'beautify' || selectedMarkId !== null) && !ocrMode && !isLongCapturing;

              if (!showSubbar) return null;

              const currentTextMark = editing !== null
                ? (marks.find(item => item.id === editing) || activeEditingMarkRef.current)
                : (selectedMark && selectedMark.kind === 'text' ? selectedMark : null);

              const currentTextFontSize = (() => {
                if (currentTextMark?.fontSize) {
                  const bounds = getViewportBounds();
                  const size = manifestRef.current || { width: bounds.width, height: bounds.height };
                  const scaleX = bounds.width / size.width;
                  return Math.round(currentTextMark.fontSize * scaleX);
                }
                return activeFontSize;
              })();

              const currentBgStyle = currentTextMark?.bgStyle ?? activeBgStyle;

              return (
                <div className="annotation-subbar">
                  {isShapeContext && (
                    <>
                      <div className="text-style-toggles">
                        <button
                          type="button"
                          className={`style-pill ${(selectedMark ? selectedMark.kind === 'rectangle' : activeShapeMode === 'rectangle') ? 'active' : ''}`}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => {
                            setActiveShapeMode('rectangle');
                            if (tool !== 'select') setTool('rectangle');
                            if (selectedMarkId !== null) {
                              setMarks(old => old.map(m => (m.id === selectedMarkId && (m.kind === 'rectangle' || m.kind === 'ellipse') ? { ...m, kind: 'rectangle' } : m)));
                            }
                          }}
                        >
                          矩形
                        </button>
                        <button
                          type="button"
                          className={`style-pill ${(selectedMark ? selectedMark.kind === 'ellipse' : activeShapeMode === 'ellipse') ? 'active' : ''}`}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => {
                            setActiveShapeMode('ellipse');
                            if (tool !== 'select') setTool('ellipse');
                            if (selectedMarkId !== null) {
                              setMarks(old => old.map(m => (m.id === selectedMarkId && (m.kind === 'rectangle' || m.kind === 'ellipse') ? { ...m, kind: 'ellipse' } : m)));
                            }
                          }}
                        >
                          椭圆
                        </button>
                      </div>
                      <span className="subbar-divider" />
                    </>
                  )}
                  {isDrawContext && (() => {
                    const currentDraw = selectedMark
                      ? (selectedMark.kind as 'arrow' | 'brush' | 'step')
                      : (tool === 'arrow' || tool === 'brush' || tool === 'step' ? tool : activeDrawMode);
                    return (
                      <>
                        <div className="text-style-toggles">
                          <button
                            type="button"
                            className={`style-pill ${currentDraw === 'arrow' ? 'active' : ''}`}
                            onPointerDown={e => e.preventDefault()}
                            onClick={() => {
                              setActiveDrawMode('arrow');
                              setTool('arrow');
                            }}
                          >
                            箭头
                          </button>
                          <button
                            type="button"
                            className={`style-pill ${currentDraw === 'brush' ? 'active' : ''}`}
                            onPointerDown={e => e.preventDefault()}
                            onClick={() => {
                              setActiveDrawMode('brush');
                              setTool('brush');
                            }}
                          >
                            画笔
                          </button>
                          <button
                            type="button"
                            className={`style-pill ${currentDraw === 'step' ? 'active' : ''}`}
                            onPointerDown={e => e.preventDefault()}
                            onClick={() => {
                              setActiveDrawMode('step');
                              setTool('step');
                            }}
                          >
                            序号
                          </button>
                        </div>
                        <span className="subbar-divider" />
                      </>
                    );
                  })()}
                  {!isObfuscateContext && (
                    <div className="annotation-colors">
                      {COLOR_PALETTE.map(c => (
                        <button
                          key={c}
                          type="button"
                          className={`palette-dot ${activeColor === c ? 'active' : ''}`}
                          style={{ background: c }}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => {
                            setActiveColor(c);
                            if (editing !== null || selectedMarkId !== null) {
                              updateEditingColor(c);
                            }
                          }}
                          aria-label={`颜色: ${c}`}
                        />
                      ))}
                    </div>
                  )}

                  {!isObfuscateContext && <span className="subbar-divider" />}

                  {isStepContext ? (
                    <>
                      <div className="annotation-widths">
                        {STEP_SIZES.map(s => (
                          <button
                            key={s.value}
                            type="button"
                            className={`width-pill ${activeStepSize === s.value ? 'active' : ''}`}
                            onPointerDown={e => e.preventDefault()}
                            onClick={() => setActiveStepSize(s.value)}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                      <span className="subbar-divider" />
                      <button
                        type="button"
                        className="step-reset-btn"
                        onPointerDown={e => e.preventDefault()}
                        onClick={() => {
                          setManualNextStep(1);
                          setStatus('序号已重置为 1');
                        }}
                        title="重置序号从 1 开始"
                      >
                        从 1 重置 (下个: {nextStepNumber})
                      </button>
                    </>
                  ) : isTextContext ? (
                    <>
                      <div className="annotation-widths">
                        {FONT_SIZES.map(item => (
                          <button
                            key={item.value}
                            type="button"
                            className={`width-pill ${Math.abs(currentTextFontSize - item.value) <= 2 ? 'active' : ''}`}
                            onPointerDown={e => e.preventDefault()}
                            onClick={() => {
                              setActiveFontSize(item.value);
                              updateEditingFontSize(item.value);
                            }}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                      <span className="subbar-divider" />
                      <div className="text-style-toggles">
                        <button
                          type="button"
                          className={`style-pill ${currentBgStyle === 'none' ? 'active' : ''}`}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => {
                            setActiveBgStyle('none');
                            const targetId = editing ?? selectedMarkId;
                            if (targetId !== null) {
                              const bounds = getViewportBounds();
                              const size = manifestRef.current || { width: bounds.width, height: bounds.height };
                              const scaleX = bounds.width / size.width;
                              setMarks(old =>
                                old.map(m => {
                                  if (m.id !== targetId) return m;
                                  const padX = 7.5 / scaleX;
                                  const padY = 5.5 / scaleX;
                                  const rect = measureTextRect(
                                    m.text || '',
                                    m.fontSize || 24,
                                    m.rect.x,
                                    m.rect.y,
                                    scaleX,
                                    'none',
                                  );
                                  return { ...m, bgStyle: 'none', padX, padY, rect };
                                }),
                              );
                            }
                          }}
                        >
                          描边
                        </button>
                        <button
                          type="button"
                          className={`style-pill ${currentBgStyle === 'fill' ? 'active' : ''}`}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => {
                            setActiveBgStyle('fill');
                            const targetId = editing ?? selectedMarkId;
                            if (targetId !== null) {
                              const bounds = getViewportBounds();
                              const size = manifestRef.current || { width: bounds.width, height: bounds.height };
                              const scaleX = bounds.width / size.width;
                              setMarks(old =>
                                old.map(m => {
                                  if (m.id !== targetId) return m;
                                  const padX = 12 / scaleX;
                                  const padY = 8 / scaleX;
                                  const rect = measureTextRect(
                                    m.text || '',
                                    m.fontSize || 24,
                                    m.rect.x,
                                    m.rect.y,
                                    scaleX,
                                    'fill',
                                  );
                                  return { ...m, bgStyle: 'fill', padX, padY, rect };
                                }),
                              );
                            }
                          }}
                        >
                          气泡
                        </button>
                      </div>
                    </>
                  ) : isObfuscateContext ? (
                    <>
                      <div className="text-style-toggles">
                        <button
                          type="button"
                          className={`style-pill ${(selectedMark ? selectedMark.kind === 'mosaic' : activeObfuscateMode === 'mosaic') ? 'active' : ''}`}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => {
                            setActiveObfuscateMode('mosaic');
                            if (tool !== 'select') setTool('mosaic');
                            if (selectedMarkId !== null) {
                              setMarks(old => old.map(m => (m.id === selectedMarkId && (m.kind === 'blur' || m.kind === 'mosaic') ? { ...m, kind: 'mosaic' } : m)));
                            }
                          }}
                        >
                          马赛克
                        </button>
                        <button
                          type="button"
                          className={`style-pill ${(selectedMark ? selectedMark.kind === 'blur' : activeObfuscateMode === 'blur') ? 'active' : ''}`}
                          onPointerDown={e => e.preventDefault()}
                          onClick={() => {
                            setActiveObfuscateMode('blur');
                            if (tool !== 'select') setTool('blur');
                            if (selectedMarkId !== null) {
                              setMarks(old => old.map(m => (m.id === selectedMarkId && (m.kind === 'blur' || m.kind === 'mosaic') ? { ...m, kind: 'blur' } : m)));
                            }
                          }}
                        >
                          高斯模糊
                        </button>
                      </div>
                      <span className="subbar-divider" />
                      <div className="annotation-widths">
                        <span style={{ fontSize: 11, color: '#94a3b8', paddingRight: 4 }}>
                          强度:
                        </span>
                        {BLUR_INTENSITIES.map(w => (
                          <button
                            key={w.value}
                            type="button"
                            className={`width-pill ${activeLineWidth === w.value ? 'active' : ''}`}
                            onPointerDown={e => e.preventDefault()}
                            onClick={() => updateEditingLineWidth(w.value)}
                          >
                            {w.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="annotation-widths">
                      {LINE_WIDTHS.map(w => (
                        <button
                          key={w.value}
                          type="button"
                          className={`width-pill ${activeLineWidth === w.value ? 'active' : ''}`}
                          onClick={() => updateEditingLineWidth(w.value)}
                        >
                          {w.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {selectedMarkId !== null && (
                    <>
                      <span className="subbar-divider" />
                      <button
                        type="button"
                        className="text-delete-pill"
                        onPointerDown={e => e.preventDefault()}
                        onClick={() => deleteMark(selectedMarkId)}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* PixPin-style Inline Text Editor */}
      {editing !== null && (() => {
        const mark = marks.find(item => item.id === editing) || activeEditingMarkRef.current;
        if (!mark) return null;
        const bounds = getViewportBounds();
        const size = manifestRef.current || { width: bounds.width, height: bounds.height };
        const scaleX = bounds.width / size.width;
        const selCss = toCssRect(mark.rect);
        const selBounding = selection ? toCssRect(selection) : { x: 0, y: 0, width: bounds.width, height: bounds.height };
        const maxW = Math.max(160, selBounding.x + selBounding.width - selCss.x - 8);
        const cssFontSize = mark.fontSize ? Math.round(mark.fontSize * scaleX) : activeFontSize;
        const textColor = mark.color || activeColor;
        const isFill = (mark.bgStyle || activeBgStyle) === 'fill';
        const cssLineHeight = getTextLineHeight(cssFontSize);
        const padCssX = isFill ? 10.5 : 6;
        const padCssY = isFill ? 6.5 : 4;
        const singleLineHeight = cssLineHeight + Math.round(padCssY * 2) + 3;

        return (
          <textarea
            ref={textareaRef}
            autoFocus
            className="text-editor"
            placeholder="Enter 完成, Shift+Enter 换行"
            style={{
              left: `${Math.round(selCss.x)}px`,
              top: `${Math.round(selCss.y)}px`,
              maxWidth: `${Math.round(maxW)}px`,
              fontSize: `${cssFontSize}px`,
              lineHeight: `${cssLineHeight}px`,
              padding: `${padCssY}px ${padCssX}px`,
              minHeight: `${singleLineHeight}px`,
              height: editingText ? undefined : `${singleLineHeight}px`,
              color: textColor,
              borderColor: 'var(--ps-primary)',
              caretColor: 'var(--ps-primary)',
              background: isFill ? 'rgba(18, 22, 28, 0.94)' : 'rgba(15, 23, 42, 0.75)',
            }}
            value={editingText}
            onPointerDown={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onWheel={onWheel}
            onChange={e => {
              setEditingText(e.target.value);
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.max(singleLineHeight, el.scrollHeight)}px`;
            }}
            onBlur={e => {
              if (justStartedEditingRef.current) return;
              const val = e.target.value.trim();
              if (val.length > 0) {
                commitEditingText(val);
              } else {
                cancelEditingText();
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelEditingText();
              } else if (e.key === 'Enter') {
                if (e.shiftKey) {
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                commitEditingText(e.currentTarget.value);
              }
            }}
          />
        );
      })()}

      {/* Long Capture Real-time Thumbnail Preview */}
      {isLongCapturing && longCapturePreview && selection && (() => {
        const selCss = toCssRect(selection);
        const hasRightSpace = selCss.x + selCss.width + 190 <= window.innerWidth;
        const previewLeft = hasRightSpace
          ? selCss.x + selCss.width + 14
          : Math.max(14, selCss.x - 184);
        const previewTop = Math.max(14, Math.min(window.innerHeight - 440, selCss.y));

        return (
          <div
            className="long-capture-preview-card"
            style={{
              position: 'fixed',
              left: `${Math.round(previewLeft)}px`,
              top: `${Math.round(previewTop)}px`,
              zIndex: 9999,
            }}
          >
            <div className="long-capture-preview-header">
              <span>长截图预览</span>
              <span className="long-capture-badge">{longCaptureHeight}px</span>
            </div>
            <div
              className="long-capture-preview-body"
              style={
                beautifyConfig.enabled
                  ? {
                      background:
                        (BACKGROUND_PRESETS.find(b => b.id === beautifyConfig.backgroundId) || BACKGROUND_PRESETS[0]).type === 'gradient'
                          ? (BACKGROUND_PRESETS.find(b => b.id === beautifyConfig.backgroundId) || BACKGROUND_PRESETS[0]).value
                          : (BACKGROUND_PRESETS.find(b => b.id === beautifyConfig.backgroundId) || BACKGROUND_PRESETS[0]).type === 'solid'
                          ? (BACKGROUND_PRESETS.find(b => b.id === beautifyConfig.backgroundId) || BACKGROUND_PRESETS[0]).value
                          : 'rgba(0, 0, 0, 0.2)',
                      padding: '8px 6px',
                    }
                  : undefined
              }
            >
              <div
                style={
                  beautifyConfig.enabled
                    ? {
                        width: '100%',
                        borderRadius: '4px',
                        overflow: 'hidden',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                      }
                    : { width: '100%' }
                }
              >
                {beautifyConfig.enabled && beautifyConfig.windowHeader && (
                  <div
                    style={{
                      height: '14px',
                      background: beautifyConfig.windowHeaderStyle === 'mac-dark' ? '#1e293b' : '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: '6px',
                      gap: '3px',
                    }}
                  >
                    <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#ff5f56' }} />
                    <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#ffbd2e' }} />
                    <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#27c93f' }} />
                  </div>
                )}
                <img src={longCapturePreview} alt="长图预览" />
              </div>
            </div>
            <div className="long-capture-preview-footer">
              <span className="long-capture-pulse-dot" />
              <span>{longCaptureIsBottom ? '已到页面底部' : '滚轮或按空格/向下拼接'}</span>
            </div>
          </div>
        );
      })()}

      {/* Floating Status Pill */}
      {!busy && (
        <div className="overlay-status">
          <span className="status-dot" />
          <span>{status}</span>
        </div>
      )}
    </main>
  );
}

function ToolbarButton({
  icon,
  label,
  hint,
  active,
  primary,
  disabled,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={hint ? `${label} · ${hint}` : label}>
      <button
        type="button"
        className={`tb-btn ${active ? 'is-active' : ''} ${primary ? 'is-primary' : ''}`}
        disabled={disabled}
        onClick={onClick}
      >
        {icon && <span className="tb-btn-icon">{icon}</span>}
        <span className="tb-btn-label">{label}</span>
      </button>
    </Tooltip>
  );
}

function drawHandles(ctx: CanvasRenderingContext2D, rect: Rect) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 2;

  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const points = [
    { x: rect.x, y: rect.y },
    { x: midX, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: midY },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: midX, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x, y: midY },
  ];

  for (const point of points) {
    ctx.beginPath();
    ctx.roundRect(point.x - 4, point.y - 4, 8, 8, 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrowHandles(ctx: CanvasRenderingContext2D, start: Point, end: Point) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 4;

  for (const point of [start, end]) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawMarks(
  ctx: CanvasRenderingContext2D,
  marks: Mark[],
  offset?: Rect,
  editingId?: number | null,
  selectedMarkId?: number | null,
  hoveredMarkId?: number | null,
  base?: HTMLCanvasElement | null,
) {
  const dx = offset ? -offset.x : 0;
  const dy = offset ? -offset.y : 0;
  for (const mark of marks) {
    if (editingId && mark.id === editingId) {
      continue;
    }
    const rect = { ...mark.rect, x: mark.rect.x + dx, y: mark.rect.y + dy };
    const color = mark.color || '#ef4444';
    const lineWidth = mark.lineWidth || 3;

    if (mark.kind === 'rectangle') {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }

    if (mark.kind === 'ellipse') {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        Math.abs(rect.width / 2),
        Math.abs(rect.height / 2),
        0,
        0,
        2 * Math.PI,
      );
      ctx.stroke();
      ctx.restore();
    }

    if (!offset && (mark.kind === 'rectangle' || mark.kind === 'ellipse')) {
      const isSelected = mark.id === selectedMarkId;
      const isHovered = mark.id === hoveredMarkId && !isSelected;
      if (isSelected || isHovered) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = isSelected ? '#10b981' : 'rgba(16, 185, 129, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4);
        ctx.restore();
      }
      if (isSelected) {
        drawHandles(ctx, rect);
      }
    }

    if (mark.kind === 'arrow' && mark.start && mark.end) {
      const startPt = { x: mark.start.x + dx, y: mark.start.y + dy };
      const endPt = { x: mark.end.x + dx, y: mark.end.y + dy };
      drawArrow(
        ctx,
        startPt,
        endPt,
        color,
        lineWidth,
      );
      if (!offset) {
        const isSelected = mark.id === selectedMarkId;
        const isHovered = mark.id === hoveredMarkId && !isSelected;
        if (isSelected) {
          drawArrowHandles(ctx, startPt, endPt);
        } else if (isHovered) {
          ctx.save();
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          for (const pt of [startPt, endPt]) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 6, 0, 2 * Math.PI);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    if (mark.kind === 'brush' && mark.points && mark.points.length > 0) {
      drawBrushStroke(
        ctx,
        mark.points.map(p => ({ x: p.x + dx, y: p.y + dy })),
        color,
        lineWidth,
      );
    }

    if (mark.kind === 'step') {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const radius = Math.max(8, rect.width / 2);
      const isSelected = !offset && mark.id === selectedMarkId;
      const isHovered = !offset && mark.id === hoveredMarkId;

      ctx.save();
      // Drop shadow for legibility
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;

      // Circle background
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Sharp white rim border
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = Math.max(2, Math.round(radius * 0.12));
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Number in center
      const stepNum = mark.step ?? 1;
      const fontSize = mark.fontSize || Math.round(radius * 1.15);
      ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isLightColor(color) ? '#111827' : '#ffffff';
      ctx.fillText(String(stepNum), cx, cy + 0.5);
      ctx.restore();

      // Selection / hover indicator ring
      if (isSelected || isHovered) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = isSelected ? '#10b981' : 'rgba(16, 185, 129, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 4, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (mark.kind === 'blur') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      const blurPx = lineWidth * 3.5;
      ctx.filter = `blur(${blurPx}px)`;
      if (base) {
        ctx.drawImage(base, dx, dy);
      } else {
        ctx.drawImage(ctx.canvas, 0, 0);
      }
      ctx.restore();
    }

    if (mark.kind === 'mosaic') {
      const image = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
      const block = Math.max(6, lineWidth * 2);
      for (let y = 0; y < rect.height; y += block) {
        for (let x = 0; x < rect.width; x += block) {
          let r = 0,
            g = 0,
            b = 0,
            n = 0;
          for (let yy = y; yy < Math.min(y + block, rect.height); yy++) {
            for (let xx = x; xx < Math.min(x + block, rect.width); xx++) {
              const i = (yy * rect.width + xx) * 4;
              r += image.data[i];
              g += image.data[i + 1];
              b += image.data[i + 2];
              n++;
            }
          }
          ctx.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
          ctx.fillRect(
            rect.x + x,
            rect.y + y,
            Math.min(block, rect.width - x),
            Math.min(block, rect.height - y),
          );
        }
      }
    }

    if (mark.kind === 'text' && mark.text && mark.text.trim().length > 0) {
      const fontSize = mark.fontSize || 24;
      const lineHeight = getTextLineHeight(fontSize);
      const padX = mark.padX ?? (mark.bgStyle === 'fill' ? 12 : 7.5);
      const padY = mark.padY ?? (mark.bgStyle === 'fill' ? 8 : 5.5);

      ctx.save();
      ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = 'top';

      if (mark.bgStyle === 'fill') {
        // High-legibility badge/bubble background
        ctx.save();
        ctx.fillStyle = 'rgba(18, 22, 28, 0.9)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(rect.x, rect.y, rect.width, rect.height, 6);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else {
        // High-contrast shadow for stroke/plain mode
        ctx.shadowColor = isLightColor(color) ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.85)';
        ctx.shadowBlur = Math.max(2, Math.round(fontSize * 0.12));
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = Math.max(1, Math.round(fontSize * 0.05));
      }

      ctx.fillStyle = color;
      const lines = mark.text.split('\n');
      const halfLeading = Math.round((lineHeight - fontSize) / 2);
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], rect.x + padX, rect.y + padY + halfLeading + i * lineHeight);
      }
      ctx.restore();

      // Subtle dashed highlight when hovered or selected (only during interactive mode, not export)
      if (!offset && (mark.id === selectedMarkId || mark.id === hoveredMarkId)) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = mark.id === selectedMarkId ? '#10b981' : 'rgba(16, 185, 129, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4);
        ctx.restore();
        if (mark.id === selectedMarkId) {
          drawHandles(ctx, rect);
        }
      }
    }
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  width = 3,
) {
  const headlen = Math.max(14, width * 3.5);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = Math.atan2(dy, dx);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - headlen * Math.cos(angle - Math.PI / 6),
    to.y - headlen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - headlen * Math.cos(angle + Math.PI / 6),
    to.y - headlen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawDraftMark(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  tool: Tool,
  color = '#ef4444',
  lineWidth = 3,
) {
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = tool === 'mosaic' ? '#f59e0b' : tool === 'blur' ? '#38bdf8' : color;
  ctx.lineWidth = lineWidth;

  if (tool === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      Math.abs(rect.width / 2),
      Math.abs(rect.height / 2),
      0,
      0,
      2 * Math.PI,
    );
    ctx.stroke();
  } else {
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }
  ctx.restore();
}

function drawBrushStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  width = 4,
) {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, width / 2, 0, 2 * Math.PI);
    ctx.fill();
  } else if (points.length === 2) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  ctx.restore();
}
