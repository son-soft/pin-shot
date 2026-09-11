import {
  IconClose,
  IconCopy,
  IconCrossCircleStroked,
  IconFolder,
  IconInfoCircle,
  IconTickCircle,
} from '@douyinfe/semi-icons';
import { Button, Tooltip } from '@douyinfe/semi-ui';
import { listen } from '@tauri-apps/api/event';
import React, { useEffect, useRef, useState } from 'react';
import { hideToast, showInFolder, ToastOptions } from './api';

export function ToastWindow() {
  const [data, setData] = useState<ToastOptions | null>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveredRef = useRef(false);

  const dismiss = () => {
    setVisible(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTimeout(() => {
      hideToast().catch(() => {});
      setData(null);
    }, 220);
  };

  const startDismissTimer = (delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!isHoveredRef.current) {
        dismiss();
      }
    }, delay);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ToastOptions>('show-toast', event => {
      const payload = event.payload;
      setData(payload);
      setCopied(false);
      setVisible(true);
      const defaultDuration =
        payload.kind === 'error' ? 4500 : payload.kind === 'save' ? 4000 : 2800;
      startDismissTimer(payload.duration ?? defaultDuration);
    }).then(fn => {
      unlisten = fn;
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      unlisten?.();
      window.removeEventListener('keydown', onKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    isHoveredRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleMouseLeave = () => {
    isHoveredRef.current = false;
    startDismissTimer(2000);
  };

  const handleOpenFolder = async () => {
    if (!data?.path) return;
    try {
      await showInFolder(data.path);
      dismiss();
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

  const handleCopyPath = async () => {
    if (!data?.path) return;
    try {
      await navigator.clipboard.writeText(data.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  if (!data) {
    return <div className="toast-window-root" />;
  }

  const kind = data.kind || (data.path ? 'save' : 'info');
  const isSave = kind === 'save' && !!data.path;

  const renderIcon = () => {
    switch (kind) {
      case 'error':
        return (
          <IconCrossCircleStroked
            size="extra-large"
            style={{ color: 'var(--ps-danger, #ef4444)' }}
          />
        );
      case 'info':
        return (
          <IconInfoCircle
            size="extra-large"
            style={{ color: '#3b82f6' }}
          />
        );
      case 'copy':
      case 'success':
      case 'save':
      default:
        return (
          <IconTickCircle
            size="extra-large"
            style={{ color: 'var(--ps-primary, #10b981)' }}
          />
        );
    }
  };

  return (
    <div className="toast-window-root">
      <div
        className={`toast-card toast-${kind} ${visible ? 'toast-visible' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="toast-icon-badge">{renderIcon()}</div>
        <div
          className={`toast-content ${isSave ? 'is-clickable' : ''}`}
          onClick={isSave ? handleOpenFolder : undefined}
          title={isSave && data.path ? `点击在资源管理器中定位：${data.path}` : undefined}
        >
          <div className="toast-title-row">
            <span className="toast-title">
              {data.message || (isSave ? '截图已保存' : '操作成功')}
            </span>
          </div>
          {isSave ? (
            <div className="toast-path" title={data.path || ''}>
              {data.path}
            </div>
          ) : data.subtext ? (
            <div className="toast-subtext">{data.subtext}</div>
          ) : null}
        </div>
        <div className="toast-actions">
          {isSave && (
            <>
              <Button
                theme="light"
                type="tertiary"
                size="small"
                icon={<IconFolder />}
                onClick={handleOpenFolder}
                title="在文件夹中显示"
              >
                打开
              </Button>
              <Tooltip content={copied ? '已复制路径' : '复制路径'} position="top">
                <Button
                  theme="borderless"
                  type="tertiary"
                  size="small"
                  icon={<IconCopy />}
                  onClick={handleCopyPath}
                  style={{ color: copied ? 'var(--ps-primary, #10b981)' : undefined }}
                />
              </Tooltip>
            </>
          )}
          <Button
            theme="borderless"
            type="tertiary"
            size="small"
            icon={<IconClose />}
            onClick={dismiss}
            title="关闭"
          />
        </div>
      </div>
    </div>
  );
}
