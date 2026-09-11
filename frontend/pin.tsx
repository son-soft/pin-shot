import {
  IconClose,
  IconCopy,
  IconSaveStroked,
} from '@douyinfe/semi-icons';
import { IconPin } from './icons';
import { Button, Tooltip, Typography } from '@douyinfe/semi-ui';
import { PhysicalSize } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';
import React, { useEffect, useRef, useState } from 'react';
import {
  appToast,
  currentWindow,
  getPinInitData,
  pinAction,
  pinReady,
  PinManifest,
  ocrPin,
  copyTextToClipboard,
  OcrResponse,
} from './api';

export function PinWindow({ pinId, onFinished }: { pinId: string; onFinished?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [manifest, setManifest] = useState<PinManifest | null>(null);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [hover, setHover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(1);
  const [isClickThrough, setIsClickThrough] = useState(false);
  const [ocrData, setOcrData] = useState<OcrResponse | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [textSelectable, setTextSelectable] = useState(true);
  const [selectedText, setSelectedText] = useState('');
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const ocrTextLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenClickThrough: (() => void) | undefined;

    const loadData = async () => {
      try {
        const data = await getPinInitData(pinId);
        if (disposed) return;
        setManifest({
          pinId: data.pinId,
          width: data.width,
          height: data.height,
          alwaysOnTop: data.alwaysOnTop,
          clickThrough: data.clickThrough,
        });
        if (data.clickThrough !== undefined) {
          setIsClickThrough(data.clickThrough);
        }
        setBuffer(data.pixels);
      } catch {
        // Window was pre-warmed as standby; wait for pin-init event
        if (!disposed) {
          listen(`pin-init-${pinId}`, async () => {
            if (disposed) return;
            try {
              const data = await getPinInitData(pinId);
              if (disposed) return;
              setManifest({
                pinId: data.pinId,
                width: data.width,
                height: data.height,
                alwaysOnTop: data.alwaysOnTop,
                clickThrough: data.clickThrough,
              });
              if (data.clickThrough !== undefined) {
                setIsClickThrough(data.clickThrough);
              }
              setBuffer(data.pixels);
            } catch (err) {
              if (!disposed) setError(err instanceof Error ? err.message : '无法加载钉图');
            }
          }).then(stop => {
            if (disposed) stop();
            else unlisten = stop;
          });
        }
      }
    };

    void loadData();

    listen<boolean>(`pin-click-through-${pinId}`, event => {
      if (disposed) return;
      setIsClickThrough(event.payload);
      setManifest(old => (old ? { ...old, clickThrough: event.payload } : old));
    }).then(stop => {
      if (disposed) stop();
      else unlistenClickThrough = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenClickThrough?.();
    };
  }, [pinId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !manifest || !buffer) return;
    const source = document.createElement('canvas');
    source.width = manifest.width;
    source.height = manifest.height;
    source
      .getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray(buffer), manifest.width, manifest.height),
        0,
        0,
      );

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const scale = Math.min(bounds.width / manifest.width, bounds.height / manifest.height);
      const width = manifest.width * scale;
      const height = manifest.height * scale;
      const devicePixelRatio = window.devicePixelRatio;

      canvas.width = Math.max(1, Math.round(bounds.width * devicePixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * devicePixelRatio));

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.clearRect(0, 0, bounds.width, bounds.height);

      const nativeSize =
        Math.round(width * devicePixelRatio) === manifest.width &&
        Math.round(height * devicePixelRatio) === manifest.height;
      ctx.imageSmoothingEnabled = !nativeSize;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, (bounds.width - width) / 2, (bounds.height - height) / 2, width, height);
    };

    draw();
    let frameId: number | undefined;
    const initialRaf = requestAnimationFrame(() => {
      frameId = requestAnimationFrame(() => {
        void pinReady(pinId);
      });
    });
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(initialRaf);
      if (frameId) cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [buffer, manifest, pinId]);

  useEffect(() => {
    document.documentElement.classList.add('is-pin');
    document.body.classList.add('is-pin');
    return () => {
      document.documentElement.classList.remove('is-pin');
      document.body.classList.remove('is-pin');
    };
  }, []);

  const [ghostOpacity, setGhostOpacity] = useState(0.7);

  // Automatically run offline OCR when pin image data is loaded
  useEffect(() => {
    if (!manifest || !buffer) return;
    let cancelled = false;
    setOcrLoading(true);
    ocrPin(pinId)
      .then(res => {
        if (!cancelled) {
          setOcrData(res);
        }
      })
      .catch(err => {
        console.warn('OCR on pin failed:', err);
      })
      .finally(() => {
        if (!cancelled) setOcrLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pinId, manifest?.width, manifest?.height]);

  // Monitor text selection within pinned window to show floating copy action
  useEffect(() => {
    const handleSelection = () => {
      const sel = window.getSelection();
      const layer = ocrTextLayerRef.current;
      if (!sel || sel.isCollapsed || !layer || sel.rangeCount === 0) {
        setSelectedText('');
        setSelectionPos(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) {
        setSelectedText('');
        setSelectionPos(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length > 0) {
        setSelectedText(text);
        try {
          const rect = range.getBoundingClientRect();
          setSelectionPos({
            x: Math.max(10, Math.min(window.innerWidth - 100, rect.left + rect.width / 2 - 45)),
            y: Math.max(8, rect.top - 34),
          });
        } catch {
          setSelectionPos(null);
        }
      } else {
        setSelectedText('');
        setSelectionPos(null);
      }
    };

    document.addEventListener('selectionchange', handleSelection);
    return () => document.removeEventListener('selectionchange', handleSelection);
  }, []);

  const copySelectedText = async () => {
    if (!selectedText) return;
    try {
      await copyTextToClipboard(selectedText);
      setSelectedText('');
      setSelectionPos(null);
      window.getSelection()?.removeAllRanges();
    } catch {
      appToast.error('复制失败');
    }
  };

  const copyAllOcrText = async () => {
    if (!ocrData || !ocrData.fullText.trim()) {
      if (!ocrLoading) {
        appToast.info('贴图中未识别到任何文字');
      }
      return;
    }
    try {
      await copyTextToClipboard(ocrData.fullText);
    } catch {
      appToast.error('复制失败');
    }
  };

  const toggleTextSelectable = () => {
    if (ocrLoading || !ocrData || !ocrData.fullText.trim()) return;
    setTextSelectable(prev => {
      const next = !prev;
      if (!next) {
        setSelectedText('');
        setSelectionPos(null);
        window.getSelection()?.removeAllRanges();
      }
      return next;
    });
  };

  const changeGhostOpacity = async (val: number) => {
    const next = Math.max(0.15, Math.min(0.95, Math.round(val * 100) / 100));
    setGhostOpacity(next);
    try {
      await pinAction(pinId, 'setGhostOpacity', next);
    } catch {
      // ignore
    }
  };

  const action = async (value: 'copy' | 'save' | 'toggleTopmost' | 'close' | 'toggleClickThrough' | 'cancelClickThrough') => {
    try {
      if (value === 'close') {
        await pinAction(pinId, value);
        if (onFinished) onFinished();
        return;
      }
      if (value === 'toggleTopmost') {
        await pinAction(pinId, value);
        setManifest(old => (old ? { ...old, alwaysOnTop: !old.alwaysOnTop } : old));
      }
      if (value === 'toggleClickThrough') {
        const next = !isClickThrough;
        setIsClickThrough(next);
        setManifest(old => (old ? { ...old, clickThrough: next } : old));
        await pinAction(pinId, next ? 'toggleClickThrough' : 'cancelClickThrough', ghostOpacity);
      }
      if (value === 'cancelClickThrough') {
        setIsClickThrough(false);
        setManifest(old => (old ? { ...old, clickThrough: false } : old));
        await pinAction(pinId, 'cancelClickThrough');
      }
      if (value === 'copy' || value === 'save') {
        const res = await pinAction(pinId, value);
        if (value === 'save' && res?.path) {
          await appToast.save(res.path, '贴图已保存');
        }
      }
    } catch (cause) {
      appToast.error(cause instanceof Error ? cause.message : '操作失败');
    }
  };

  const resetOriginalSize = async () => {
    if (!manifest) return;
    try {
      const win = currentWindow();
      await win.setSize(new PhysicalSize(manifest.width, manifest.height));
    } catch {
      // ignore
    }
  };

  // Double click closes pinned window (Snipaste / PixPin default)
  const onDoubleClick = () => {
    void action('close');
  };

  // Mouse wheel: in click-through mode tunes ghost opacity; in regular mode zooms or tunes normal opacity
  const onWheel = async (event: React.WheelEvent) => {
    event.preventDefault();
    if (!manifest) return;

    if (isClickThrough) {
      const delta = event.deltaY < 0 ? 0.05 : -0.05;
      void changeGhostOpacity(ghostOpacity + delta);
      return;
    }

    if (event.ctrlKey || event.shiftKey || event.altKey) {
      // Adjust opacity
      const delta = event.deltaY < 0 ? 0.08 : -0.08;
      setOpacity(old => Math.max(0.2, Math.min(1.0, Math.round((old + delta) * 100) / 100)));
      return;
    }

    // Zoom window scale
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    try {
      const win = currentWindow();
      const current = await win.innerSize();
      const nextWidth = Math.max(48, Math.min(3840, Math.round(current.width * factor)));
      const nextHeight = Math.max(48, Math.min(2160, Math.round(current.height * factor)));
      await win.setSize(new PhysicalSize(nextWidth, nextHeight));
    } catch {
      // ignore
    }
  };

  // Global keyboard shortcuts within Pin window
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void action('close');
      } else if (event.ctrlKey && event.key.toLowerCase() === 'c') {
        const sel = window.getSelection();
        if (sel && sel.toString().trim().length > 0) {
          event.preventDefault();
          void copySelectedText();
          return;
        }
        event.preventDefault();
        void action('copy');
      } else if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void action('save');
      } else if (event.key.toLowerCase() === 'o' && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void copyAllOcrText();
      } else if (event.ctrlKey && event.key === '0') {
        event.preventDefault();
        void resetOriginalSize();
      } else if (event.ctrlKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        void action('toggleClickThrough');
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        void action('toggleTopmost');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [manifest, isClickThrough, selectedText, ocrData, ocrLoading]);

  if (error) {
    return (
      <div className="fatal-state">
        <Typography.Text>{error}</Typography.Text>
        <Button onClick={() => currentWindow().close()}>关闭</Button>
      </div>
    );
  }

  if (!manifest || !buffer) {
    return <div className="pin-loading" />;
  }

  return (
    <main
      className={`pin-root ${isClickThrough ? 'is-ghost' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onWheel={onWheel}
    >
      {/* High-contrast border frame ensuring pinned snippet never blends with background */}
      <div className="pin-frame" />

      {/* Interactive canvas with dragging and double-click to close */}
      <canvas
        ref={canvasRef}
        className="pin-canvas"
        style={{ opacity: isClickThrough ? ghostOpacity : opacity }}
        onPointerDown={() => {
          if (isClickThrough) return;
          currentWindow().startDragging();
        }}
        onDoubleClick={isClickThrough ? undefined : onDoubleClick}
      />

      {/* Interactive OCR Text Layer: allows hovering, selecting & copying text on the pin */}
      {!isClickThrough && textSelectable && ocrData && ocrData.lines.length > 0 && (
        <div
          ref={ocrTextLayerRef}
          className="pin-text-layer"
          onPointerDown={e => {
            if (isClickThrough) return;
            // Drag window if user clicks outside text lines or holds Alt
            if (e.target === e.currentTarget || e.altKey) {
              currentWindow().startDragging();
            }
          }}
          onDoubleClick={e => {
            if (isClickThrough) return;
            // Double click on empty background closes the pin
            if (e.target === e.currentTarget) {
              onDoubleClick();
            }
          }}
        >
          {ocrData.lines.map((line, idx) => {
            const leftPct = (line.rect[0] / manifest.width) * 100;
            const topPct = (line.rect[1] / manifest.height) * 100;
            const widthPct = (line.rect[2] / manifest.width) * 100;
            const heightPct = (line.rect[3] / manifest.height) * 100;
            return (
              <div
                key={idx}
                className="pin-ocr-line"
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${widthPct}%`,
                  height: `${heightPct}%`,
                  fontSize: `calc(${heightPct}vh * 0.82)`,
                  lineHeight: `calc(${heightPct}vh)`,
                }}
                title="按住鼠标左键可划选文字复制"
              >
                {line.text}
              </div>
            );
          })}
        </div>
      )}

      {/* Floating Copy Action Pill when text is selected */}
      {textSelectable && selectedText && selectionPos && (
        <button
          type="button"
          className="pin-selection-copy-btn"
          style={{ left: `${selectionPos.x}px`, top: `${selectionPos.y}px` }}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation();
            void copySelectedText();
          }}
          title="复制选中的文字 (Ctrl+C)"
        >
          <IconCopy size="small" />
          <span>复制文字</span>
        </button>
      )}

      {/* When in Click-Through (Ghost) mode: Prominent non-penetrating top-right action bar */}
      {isClickThrough ? (
        <div
          className="pin-ghost-bar"
          title="鼠标穿透模式：下层内容可直接操作。滚轮调节透明度，点击'取消穿透'或按 Ctrl+T 恢复"
          onWheel={e => {
            e.stopPropagation();
            const delta = e.deltaY < 0 ? 0.05 : -0.05;
            void changeGhostOpacity(ghostOpacity + delta);
          }}
        >
          <span
            className="pin-ghost-badge"
            title="滚轮调节透明度，点击恢复 70%"
            onClick={e => {
              e.stopPropagation();
              void changeGhostOpacity(0.7);
            }}
            style={{ cursor: 'pointer' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
            </svg>
            <span>穿透 {Math.round(ghostOpacity * 100)}%</span>
          </span>
          <button
            type="button"
            className="pin-ghost-btn pin-ghost-cancel-btn"
            onClick={e => {
              e.stopPropagation();
              void action('cancelClickThrough');
            }}
            title="点击取消鼠标穿透 (Ctrl+T)"
          >
            取消穿透
          </button>
          <button
            type="button"
            className="pin-ghost-btn pin-ghost-close-btn"
            onClick={e => {
              e.stopPropagation();
              void action('close');
            }}
            title="关闭贴图"
            aria-label="关闭"
          >
            <IconClose size="small" />
          </button>
        </div>
      ) : (
        /* Floating Modern Action Pill (only on hover, zero permanent obstruction) */
        <div className={`pin-chrome ${hover ? 'is-visible' : ''}`}>
          {opacity < 1 && (
            <span className="pin-opacity-pill" title="透明度 (滚轮+Ctrl 调节)">
              {Math.round(opacity * 100)}%
            </span>
          )}

          <Tooltip content="复制图片 (Ctrl+C)">
            <button
              type="button"
              className="pin-tool-btn"
              onClick={() => action('copy')}
              aria-label="复制"
            >
              <IconCopy size="small" />
            </button>
          </Tooltip>

          <Tooltip content={ocrLoading ? '正在识别…' : '右键复制全部'}>
            <button
              type="button"
              className={`pin-tool-btn ${textSelectable && ocrData?.fullText ? 'active-pin' : ''}`}
              onClick={toggleTextSelectable}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                void copyAllOcrText();
              }}
              aria-label="文字选取与复制"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7V4h16v3M9 20h6M12 4v16" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip content="保存图片 (Ctrl+S)">
            <button
              type="button"
              className="pin-tool-btn"
              onClick={() => action('save')}
              aria-label="保存"
            >
              <IconSaveStroked size="small" />
            </button>
          </Tooltip>

          <Tooltip content={manifest.alwaysOnTop ? '取消置顶 (T)' : '固定置顶 (T)'}>
            <button
              type="button"
              className={`pin-tool-btn ${manifest.alwaysOnTop ? 'active-pin' : ''}`}
              onClick={() => action('toggleTopmost')}
              aria-label="置顶"
            >
              <IconPin size={14} />
            </button>
          </Tooltip>

          <Tooltip content="鼠标穿透模式 (Ctrl+T)">
            <button
              type="button"
              className="pin-tool-btn"
              onClick={() => action('toggleClickThrough')}
              aria-label="鼠标穿透"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
              </svg>
            </button>
          </Tooltip>

          <span className="pin-chrome-divider" />

          <Tooltip content="关闭贴图 (双击 / Esc)">
            <button
              type="button"
              className="pin-tool-btn pin-close-btn"
              onClick={() => action('close')}
              aria-label="关闭"
            >
              <IconClose size="small" />
            </button>
          </Tooltip>
        </div>
      )}
    </main>
  );
}
