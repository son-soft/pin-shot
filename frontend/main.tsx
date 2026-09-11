import '@douyinfe/semi-ui/react19-adapter';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getActiveCaptureId, getSettings, ThemeMode, writeDiagnosticLog } from './api';
import { HistoryShelf } from './history_shelf';
import { Overlay } from './overlay';
import { PinWindow } from './pin';
import { Settings } from './settings';
import { ToastWindow } from './toast';
import { applyTheme } from './theme';
import './styles.css';

function reportFrontendDiagnostic(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  stack?: string,
) {
  void writeDiagnosticLog(level, source, message, stack).catch(() => {
    // Diagnostics must never create an unhandled rejection of their own.
  });
}

// 全局禁用浏览器默认右键菜单（前进、后退、刷新、检查等）
if (typeof window !== 'undefined') {
  window.addEventListener('contextmenu', e => {
    e.preventDefault();
  }, false);

  // These handlers are installed before React mounts so failures during route
  // initialization are retained in the same file as native recording logs.
  window.addEventListener('error', event => {
    const errorEvent = event as ErrorEvent;
    const error = errorEvent.error;
    const message = error instanceof Error
      ? error.message
      : errorEvent.message || '未捕获的前端异常';
    const stack = error instanceof Error ? error.stack : undefined;
    reportFrontendDiagnostic('error', 'window.onerror', message, stack);
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    const message = reason instanceof Error
      ? reason.message
      : '未处理的 Promise 拒绝: ' + String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportFrontendDiagnostic('error', 'unhandledrejection', message, stack);
  });
}

const initialHash = typeof window !== 'undefined' ? decodeURIComponent(window.location.hash) : '';
if (initialHash === '#/toast') {
  document.documentElement.classList.add('is-toast');
  document.body.classList.add('is-toast');
} else if (initialHash === '#/overlay') {
  document.documentElement.classList.add('is-overlay');
  document.body.classList.add('is-overlay');
} else if (initialHash.startsWith('#/pin/')) {
  document.documentElement.classList.add('is-pin');
  document.body.classList.add('is-pin');
} else if (initialHash === '#/history') {
  document.documentElement.classList.add('is-history');
  document.body.classList.add('is-history');
}

function route() {
  const hash = decodeURIComponent(window.location.hash);
  if (hash === '#/overlay') return <OverlayHost />;
  if (hash.startsWith('#/pin/')) return <PinWindow pinId={hash.slice('#/pin/'.length)} />;
  if (hash === '#/toast') return <ToastHost />;
  if (hash === '#/history') return <HistoryShelfHost />;
  return <Settings />;
}

function HistoryShelfHost() {
  useEffect(() => {
    document.documentElement.classList.add('is-history');
    document.body.classList.add('is-history');
    return () => {
      document.documentElement.classList.remove('is-history');
      document.body.classList.remove('is-history');
    };
  }, []);
  return <HistoryShelf />;
}

function ToastHost() {
  useEffect(() => {
    document.documentElement.classList.add('is-toast');
    document.body.classList.add('is-toast');
    return () => {
      document.documentElement.classList.remove('is-toast');
      document.body.classList.remove('is-toast');
    };
  }, []);
  return <ToastWindow />;
}

function OverlayHost() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    document.documentElement.classList.add('is-overlay');
    document.body.classList.add('is-overlay');
    let disposed = false;
    let unlistenStarted: UnlistenFn | undefined;
    let unlistenEnded: UnlistenFn | undefined;

    listen<string>('capture-started', event => {
      if (!disposed) setSessionId(event.payload);
    }).then(stop => {
      if (disposed) { stop(); return; }
      unlistenStarted = stop;
      getActiveCaptureId().then(active => {
        if (!disposed && active) setSessionId(active);
      });
    });

    listen('capture-ended', () => {
      if (!disposed) setSessionId(null);
    }).then(stop => {
      if (disposed) { stop(); return; }
      unlistenEnded = stop;
    });

    return () => {
      disposed = true;
      unlistenStarted?.();
      unlistenEnded?.();
      document.documentElement.classList.remove('is-overlay');
      document.body.classList.remove('is-overlay');
    };
  }, []);
  return sessionId
    ? <Overlay key={sessionId} sessionId={sessionId} onFinished={() => setSessionId(null)} />
    : <div className="overlay-idle" />;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Unhandled UI exception:', error, errorInfo);
    reportFrontendDiagnostic(
      'error',
      'react.error-boundary',
      error.message,
      (error.stack || '') + ' ' + (errorInfo.componentStack || ''),
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: '#ef4444' }}>
          <p style={{ margin: '0 0 12px', fontSize: 14 }}>页面加载遇到异常</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            重新载入
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ThemeBridge({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let disposed = false;
    let unlistenTheme: UnlistenFn | undefined;

    listen<ThemeMode>('theme-changed', event => {
      applyTheme(event.payload);
    }).then(stop => {
      if (disposed) {
        stop();
      } else {
        unlistenTheme = stop;
      }
    });

    getSettings()
      .then(settings => { applyTheme(settings.theme); })
      .catch(() => { applyTheme('system'); });

    return () => {
      disposed = true;
      unlistenTheme?.();
    };
  }, []);
  return children;
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeBridge>{route()}</ThemeBridge>
  </ErrorBoundary>,
);
