import {
  IconCameraStroked,
  IconClose,
  IconCopy,
  IconDelete,
  IconFolderOpenStroked,
  IconHistory,
  IconImageStroked,
  IconSaveStroked,
  IconSearch,
} from '@douyinfe/semi-icons';
import { IconPin } from './icons';
import { Button, Empty, Spin, Tag, Tooltip } from '@douyinfe/semi-ui';
import { listen } from '@tauri-apps/api/event';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appToast,
  clearHistory,
  copyHistoryToClipboard,
  deleteHistoryItem,
  getHistoryItems,
  getHistoryPixels,
  hideHistoryShelf,
  HistoryItem,
  restoreHistoryAsPin,
  saveHistoryToFile,
  showInFolder,
  startCaptureFromUi,
} from './api';

interface PixelRecord {
  id: string;
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

export function HistoryShelf() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pixelRecord, setPixelRecord] = useState<PixelRecord | null>(null);
  const [pixelsLoading, setPixelsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [zoomPos, setZoomPos] = useState({ x: 50, y: 50 });
  const [zoomScale, setZoomScale] = useState(2.4);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const pixelCacheRef = useRef<Map<string, ArrayBuffer>>(new Map());

  const activeItem = useMemo(() => {
    if (!items.length) return null;
    return items.find(it => it.id === selectedId) || items[0];
  }, [items, selectedId]);

  const loadHistory = useCallback(async () => {
    try {
      const list = await getHistoryItems();
      setItems(list);
      setSelectedId(prev => {
        if (prev && list.some(it => it.id === prev)) return prev;
        return list[0]?.id || null;
      });
    } catch {
      setItems([]);
      setSelectedId(null);
      setPixelRecord(null);
      pixelCacheRef.current.clear();
    } finally {
      setLoading(false);
    }
  }, []);

  // Cleanup pixel cache for items that no longer exist
  useEffect(() => {
    const validIds = new Set(items.map(it => it.id));
    for (const key of pixelCacheRef.current.keys()) {
      if (!validIds.has(key)) {
        pixelCacheRef.current.delete(key);
      }
    }
  }, [items]);

  // Fetch pixels when active item changes
  useEffect(() => {
    let cancelled = false;
    if (!activeItem) {
      setPixelRecord(null);
      setPixelsLoading(false);
      return;
    }

    const currentId = activeItem.id;
    const currentW = activeItem.width;
    const currentH = activeItem.height;
    const expectedLen = currentW * currentH * 4;

    // Check if already in memory cache
    const cached = pixelCacheRef.current.get(currentId);
    if (cached && cached.byteLength === expectedLen) {
      setPixelRecord({
        id: currentId,
        buffer: cached,
        width: currentW,
        height: currentH,
      });
      setPixelsLoading(false);
      return;
    }

    setPixelsLoading(true);
    void (async () => {
      try {
        const raw = await getHistoryPixels(currentId);
        if (!cancelled) {
          if (raw.byteLength === expectedLen) {
            pixelCacheRef.current.set(currentId, raw);
            setPixelRecord({
              id: currentId,
              buffer: raw,
              width: currentW,
              height: currentH,
            });
          } else {
            console.warn(
              `Pixel data length mismatch for ${currentId}: got ${raw.byteLength}, expected ${expectedLen}`,
            );
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to get history pixels:', err);
        }
      } finally {
        if (!cancelled) {
          setPixelsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeItem?.id, activeItem?.width, activeItem?.height]);

  useEffect(() => {
    void loadHistory();

    const unlisten = listen('history-updated', () => {
      void loadHistory();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void hideHistoryShelf();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      unlisten.then(fn => fn());
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [loadHistory]);

  // Draw image on preview canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeItem) return;

    // Strict guard: ensure pixel data matches currently active item
    if (!pixelRecord || pixelRecord.id !== activeItem.id) {
      return;
    }

    try {
      const expectedByteLen = activeItem.width * activeItem.height * 4;
      if (pixelRecord.buffer.byteLength !== expectedByteLen) {
        console.warn(
          `Buffer size mismatch for item ${activeItem.id}: expected ${expectedByteLen}, got ${pixelRecord.buffer.byteLength}`,
        );
        return;
      }

      const source = document.createElement('canvas');
      source.width = activeItem.width;
      source.height = activeItem.height;
      const sCtx = source.getContext('2d');
      if (!sCtx) return;

      sCtx.putImageData(
        new ImageData(new Uint8ClampedArray(pixelRecord.buffer), activeItem.width, activeItem.height),
        0,
        0,
      );

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const displayWidth = rect.width || 340;
      const displayHeight = rect.height || 200;

      // Supersample canvas buffer by 3.5x so when scaled up on hover it stays razor sharp
      const zoomFactor = 3.5;
      const targetCanvasWidth = Math.min(
        activeItem.width,
        Math.round(displayWidth * dpr * zoomFactor),
      );
      const targetCanvasHeight = Math.min(
        activeItem.height,
        Math.round(displayHeight * dpr * zoomFactor),
      );

      canvas.width = targetCanvasWidth;
      canvas.height = targetCanvasHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, targetCanvasWidth, targetCanvasHeight);

      const scale = Math.min(
        targetCanvasWidth / activeItem.width,
        targetCanvasHeight / activeItem.height,
      );
      const drawW = activeItem.width * scale;
      const drawH = activeItem.height * scale;
      const drawX = (targetCanvasWidth - drawW) / 2;
      const drawY = (targetCanvasHeight - drawH) / 2;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, drawX, drawY, drawW, drawH);
    } catch (err) {
      console.error('Error drawing history preview canvas:', err);
    }
  }, [activeItem, pixelRecord]);

  const handleWheelAction = useCallback((clientX: number, clientY: number, deltaY: number) => {
    setIsHovered(true);
    const container = previewContainerRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const x = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
        const y = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
        setZoomPos({ x, y });
      }
    }

    const step = deltaY < 0 ? 0.3 : deltaY > 0 ? -0.3 : 0;
    if (step === 0) return;
    setZoomScale(prev => {
      const next = Math.round((prev + step) * 10) / 10;
      return Math.min(5.0, Math.max(1.0, next));
    });
  }, []);

  const handleWheelRef = useRef(handleWheelAction);
  handleWheelRef.current = handleWheelAction;

  const onNativeWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handleWheelRef.current(e.clientX, e.clientY, e.deltaY);
  }, []);

  const setPreviewContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (previewContainerRef.current) {
      previewContainerRef.current.removeEventListener('wheel', onNativeWheel);
    }
    previewContainerRef.current = node;
    if (node) {
      node.addEventListener('wheel', onNativeWheel, { passive: false });
    }
  }, [onNativeWheel]);

  const handlePreviewDoubleClick = () => {
    setZoomScale(2.4);
  };

  const handlePreviewMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = previewContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setZoomPos({ x, y });
  };

  const handlePreviewMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsHovered(true);
    handlePreviewMouseMove(e);
  };

  const handlePreviewMouseLeave = () => {
    setIsHovered(false);
    setZoomPos({ x: 50, y: 50 });
  };

  const handleRestorePin = async () => {
    if (actionBusy || !activeItem) return;
    setActionBusy(true);
    try {
      await restoreHistoryAsPin(activeItem.id);
    } catch (err) {
      appToast.error(err instanceof Error ? err.message : '贴图失败');
    } finally {
      setActionBusy(false);
    }
  };

  const handleCopy = async () => {
    if (actionBusy || !activeItem) return;
    setActionBusy(true);
    try {
      await copyHistoryToClipboard(activeItem.id);
    } catch (err) {
      appToast.error(err instanceof Error ? err.message : '复制失败');
    } finally {
      setActionBusy(false);
    }
  };

  const handleSave = async () => {
    if (actionBusy || !activeItem) return;
    setActionBusy(true);
    try {
      const path = await saveHistoryToFile(activeItem.id);
      setItems(prev =>
        prev.map(it => (it.id === activeItem.id ? { ...it, path, action: 'save' } : it)),
      );
    } catch (err) {
      appToast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setActionBusy(false);
    }
  };

  const handleDeleteCurrent = async () => {
    if (actionBusy || !activeItem) return;
    setActionBusy(true);
    try {
      const deletedId = activeItem.id;
      await deleteHistoryItem(deletedId);
      pixelCacheRef.current.delete(deletedId);
      const remaining = items.filter(it => it.id !== deletedId);
      setItems(remaining);
      setSelectedId(remaining[0]?.id || null);
      if (pixelRecord?.id === deletedId) {
        setPixelRecord(null);
      }
    } catch (err) {
      appToast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setActionBusy(false);
    }
  };

  const handleClearAll = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await clearHistory();
      setItems([]);
      setSelectedId(null);
      setPixelRecord(null);
      pixelCacheRef.current.clear();
    } catch (err) {
      appToast.error(err instanceof Error ? err.message : '清除失败');
    } finally {
      setActionBusy(false);
    }
  };

  const formatActionLabel = (action: string) => {
    switch (action) {
      case 'save':
        return { label: '已保存到本地', color: 'blue' as const };
      case 'copy':
        return { label: '已复制到剪贴板', color: 'teal' as const };
      case 'pin':
        return { label: '已贴图到桌面', color: 'indigo' as const };
      case 'ocr':
        return { label: '文字识别提取', color: 'cyan' as const };
      case 'cancel':
        return { label: '已取消', color: 'orange' as const };
      default:
        return { label: action, color: 'grey' as const };
    }
  };

  const formatTime = (timestamp: number) => {
    if (!timestamp) return '刚刚';
    const date = new Date(timestamp);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  };

  const formatShortTime = (timestamp: number) => {
    if (!timestamp) return '刚刚';
    const date = new Date(timestamp);
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${hh}:${min}:${ss}`;
  };

  return (
    <aside className="ps-history-shelf">
      <header className="ps-history-header">
        <div className="ps-history-header-left">
          <span className="ps-history-header-icon">
            <IconHistory />
          </span>
          <div className="ps-history-title-group">
            <div className="ps-history-title-row">
              <span className="ps-history-title">截图历史</span>
              <Tag size="small" color="violet" shape="circle">
                {items.length}/3 张
              </Tag>
            </div>
            <span className="ps-history-subtitle">随时追溯与快速贴出截图</span>
          </div>
        </div>
        <button
          type="button"
          className="ps-history-close-btn"
          title="关闭抽屉 (Esc)"
          onClick={() => hideHistoryShelf()}
        >
          <IconClose />
        </button>
      </header>

      <div className="ps-history-body">
        {loading ? (
          <div className="ps-history-loading">
            <Spin size="large" />
            <span>正在读取历史记录...</span>
          </div>
        ) : !items.length || !activeItem ? (
          <div className="ps-history-empty">
            <Empty
              image={<IconImageStroked style={{ fontSize: 48, color: 'var(--semi-color-text-3)' }} />}
              title="暂无历史截图记录"
              description="在截图、保存、复制、贴图或取消时，PinShot 会自动保留最近最多 3 张截图。"
            >
              <Button
                theme="solid"
                type="primary"
                icon={<IconCameraStroked />}
                onClick={() => {
                  void hideHistoryShelf();
                  void startCaptureFromUi();
                }}
              >
                立即截图
              </Button>
            </Empty>
          </div>
        ) : (
          <div className="ps-history-content">
            {/* 3 张历史截图快捷切换 Tabs */}
            {items.length > 1 && (
              <div className="ps-history-tabs">
                {items.map((it, idx) => {
                  const isActive = it.id === activeItem.id;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className={`ps-history-tab ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        if (it.id !== activeItem.id) {
                          setSelectedId(it.id);
                        }
                      }}
                    >
                      <span className="ps-history-tab-badge">
                        #{idx + 1} {idx === 0 ? '最新' : ''}
                      </span>
                      <span className="ps-history-tab-size">
                        {it.width}×{it.height}
                      </span>
                      <span className="ps-history-tab-time">{formatShortTime(it.timestamp)}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div
              ref={setPreviewContainerRef}
              className="ps-history-preview-container"
              onMouseEnter={handlePreviewMouseEnter}
              onMouseMove={handlePreviewMouseMove}
              onMouseLeave={handlePreviewMouseLeave}
              onDoubleClick={handlePreviewDoubleClick}
              onWheel={(e) => {
                e.stopPropagation();
                handleWheelAction(e.clientX, e.clientY, e.deltaY);
              }}
            >
              {(!pixelRecord || pixelRecord.id !== activeItem.id || pixelsLoading) && (
                <div className="ps-history-preview-spinner">
                  <Spin size="middle" />
                </div>
              )}
              <canvas
                ref={canvasRef}
                className="ps-history-preview-canvas"
                style={{
                  opacity: pixelRecord && pixelRecord.id === activeItem.id ? 1 : 0,
                  transform: isHovered ? `scale(${zoomScale})` : 'scale(1)',
                  transformOrigin: `${zoomPos.x}% ${zoomPos.y}%`,
                  transition: isHovered
                    ? 'transform 0.08s ease-out, opacity 0.15s ease'
                    : 'transform 0.25s cubic-bezier(0.2, 0, 0, 1), opacity 0.15s ease',
                }}
              />
              {pixelRecord && pixelRecord.id === activeItem.id && (
                <div className="ps-history-zoom-badge">
                  <IconSearch style={{ fontSize: 12, marginRight: 4 }} />
                  <span>{isHovered ? `${zoomScale.toFixed(1)}× 细节查看` : '悬浮放大'}</span>
                </div>
              )}
            </div>

            <div className="ps-history-meta-card">
              <div className="ps-history-meta-row">
                <span className="ps-history-meta-key">尺寸规格</span>
                <span className="ps-history-meta-val">
                  {activeItem.width} × {activeItem.height} 像素
                </span>
              </div>
              <div className="ps-history-meta-row">
                <span className="ps-history-meta-key">记录时间</span>
                <span className="ps-history-meta-val">{formatTime(activeItem.timestamp)}</span>
              </div>
              <div className="ps-history-meta-row">
                <span className="ps-history-meta-key">记录状态</span>
                <span>
                  {(() => {
                    const { label, color } = formatActionLabel(activeItem.action);
                    return (
                      <Tag size="small" color={color}>
                        {label}
                      </Tag>
                    );
                  })()}
                </span>
              </div>
              {activeItem.path && (
                <div className="ps-history-meta-row ps-history-path-row">
                  <span className="ps-history-meta-key">文件路径</span>
                  <div className="ps-history-path-val">
                    <span className="ps-history-path-text" title={activeItem.path}>
                      {activeItem.path}
                    </span>
                    <Tooltip content="在文件夹中显示">
                      <Button
                        size="small"
                        theme="borderless"
                        icon={<IconFolderOpenStroked />}
                        onClick={() => activeItem.path && showInFolder(activeItem.path)}
                      />
                    </Tooltip>
                  </div>
                </div>
              )}
            </div>

            <div className="ps-history-actions">
              <Button
                theme="solid"
                type="primary"
                icon={<IconPin size={14} />}
                loading={actionBusy}
                onClick={handleRestorePin}
                block
                className="ps-history-btn-pin"
              >
                贴图到桌面
              </Button>

              <div className="ps-history-btn-grid">
                <Button
                  theme="light"
                  icon={<IconCopy />}
                  loading={actionBusy}
                  onClick={handleCopy}
                >
                  复制图片
                </Button>
                <Button
                  theme="light"
                  icon={<IconSaveStroked />}
                  loading={actionBusy}
                  onClick={handleSave}
                >
                  保存文件
                </Button>
              </div>

              <div className="ps-history-btn-grid">
                <Button
                  theme="borderless"
                  type="tertiary"
                  icon={<IconDelete />}
                  loading={actionBusy}
                  onClick={handleDeleteCurrent}
                  className="ps-history-del-one-btn"
                >
                  删除此张
                </Button>
                <Button
                  theme="borderless"
                  type="danger"
                  loading={actionBusy}
                  onClick={handleClearAll}
                  className="ps-history-clear-btn"
                >
                  清空全部
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
