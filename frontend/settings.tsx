import {
  IconCameraStroked,
  IconCopy,
  IconDelete,
  IconDesktop,
  IconFolderOpenStroked,
  IconFolderStroked,
  IconKeyStroked,
  IconMoon,
  IconHistory,
  IconSaveStroked,
  IconSettingStroked,
  IconShieldStroked,
  IconSun,
  IconAlertTriangle,
} from '@douyinfe/semi-icons';
import { IconPin } from './icons';
import { Button, Divider, Select, Spin, Switch, Tag, Tooltip } from '@douyinfe/semi-ui';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  appToast,
  clearHistory,
  copyHistoryToClipboard,
  currentWindow,
  getHistoryItem,
  getHistoryItems,
  getSettings,
  HistoryItem,
  HotkeyBinding,
  pickSaveDirectory,
  restoreHistoryAsPin,
  SettingsDto,
  showHistoryShelf,
  startCaptureFromUi,
  ThemeMode,
  updateSettings,
} from './api';
import { applyTheme } from './theme';
import logoUrl from './icon.svg';

const KEYS = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
];

export function Settings() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [openingHistory, setOpeningHistory] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const openingHistoryRef = useRef(false);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion('未知'));

    getSettings()
      .then(value => {
        setSettings(value);
        setDraft(value);
        applyTheme(value.theme);
      })
      .catch(cause => {
        setError(cause instanceof Error ? cause.message : '无法加载设置');
      })
      .finally(() => setLoading(false));

    const loadHist = () => {
      void getHistoryItems().then(setHistoryItems).catch(() => {});
    };
    loadHist();
    const unlisten = listen('history-updated', loadHist);
    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  const handleThemeChange = (newTheme: ThemeMode) => {
    if (!draft) return;
    setDraft({ ...draft, theme: newTheme });
    applyTheme(newTheme);
  };

  const updateHotkey = (patch: Partial<HotkeyBinding>) => {
    setDraft(old => (old ? { ...old, hotkey: { ...old.hotkey, ...patch } } : old));
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const next = await updateSettings(draft);
      setSettings(next);
      setDraft(next);
      applyTheme(next.theme);
      appToast.success('设置已成功保存并生效');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败,请检查快捷键是否冲突');
    } finally {
      setSaving(false);
    }
  };

  const chooseDirectory = async () => {
    try {
      const path = await pickSaveDirectory();
      if (path) {
        setDraft(old => (old ? { ...old, saveDirectory: path } : old));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法选择目录');
    }
  };

  const resetDirectory = () => {
    setDraft(old => (old ? { ...old, saveDirectory: null } : old));
  };

  const resetHotkey = () => {
    updateHotkey({ ctrl: false, alt: true, shift: false, winKey: false, key: 'F2' });
  };

  const triggerTestCapture = async () => {
    try {
      await startCaptureFromUi();
    } catch (cause) {
      appToast.error(cause instanceof Error ? cause.message : '无法启动截图');
    }
  };

  const isModified = useMemo(() => {
    if (!settings || !draft) return false;
    return JSON.stringify(settings) !== JSON.stringify(draft);
  }, [settings, draft]);

  const hasModifier = useMemo(() => {
    if (!draft) return false;
    const { ctrl, alt, shift, winKey } = draft.hotkey;
    return Boolean(ctrl || alt || shift || winKey);
  }, [draft?.hotkey]);

  const hotkeyTokens = useMemo(() => {
    if (!draft?.hotkey) return [];
    const tokens: string[] = [];
    if (draft.hotkey.ctrl) tokens.push('Ctrl');
    if (draft.hotkey.alt) tokens.push('Alt');
    if (draft.hotkey.shift) tokens.push('Shift');
    if (draft.hotkey.winKey) tokens.push('Win');
    if (draft.hotkey.key) tokens.push(draft.hotkey.key);
    return tokens;
  }, [draft?.hotkey]);

  if (loading || !draft) {
    return (
      <div className="ps-loading-screen">
        <Spin size="large" />
        <div className="ps-loading-text">正在加载配置...</div>
      </div>
    );
  }

  const displayDirectory = draft.saveDirectory || '桌面(系统默认)';

  return (
    <main className="settings-root">
      {/* 顶部标题区 */}
      <header className="ps-header">
        <div className="ps-header-left">
          <img src={logoUrl} className="ps-logo-img" alt="PinShot Logo" />
          <div className="ps-title-wrapper">
            <div className="ps-title-row">
              <span className="ps-app-title">PinShot 设置</span>
              <span className="ps-version-pill">v{appVersion ?? '...'}</span>
            </div>
            <p className="ps-app-subtitle">让截图更顺手</p>
          </div>
        </div>
      </header>

      {/* 主配置滚动区域 */}
      <div className="settings-scroll">
        {/* 卡片 1: 截图快捷键 */}
        <section className="ps-card">
          <div className="ps-card-header">
            <div className="ps-card-title-group">
              <span className="ps-card-icon"><IconKeyStroked /></span>
              <span className="ps-card-title">截图全局快捷键</span>
            </div>
            <div className="ps-active-kbd-badge">
              <span className="ps-kbd-label">当前:</span>
              {hotkeyTokens.length > 0 ? (
                hotkeyTokens.map((token, idx) => (
                  <React.Fragment key={idx}>
                    <kbd className="ps-kbd-mini">{token}</kbd>
                    {idx < hotkeyTokens.length - 1 && <span className="ps-kbd-sep">+</span>}
                  </React.Fragment>
                ))
              ) : (
                <span className="ps-kbd-none">未配置</span>
              )}
            </div>
          </div>

          <p className="ps-card-caption">
            按下快捷键即可随时唤起截图选区；点击下方录制框可直接按下键盘组合键。
          </p>

          <HotkeyRecorder
            value={draft.hotkey}
            onChange={updateHotkey}
          />

          {!hasModifier && (
            <div className="ps-field-warning">
              <IconAlertTriangle />
              <span>快捷键必须包含至少一个修饰键 (Ctrl / Alt / Shift / Win)</span>
            </div>
          )}

          <div className="ps-hotkey-footer-row">
            <Button
              theme="borderless"
              size="small"
              icon={<IconCameraStroked />}
              className="ps-test-btn"
              onClick={triggerTestCapture}
            >
              测试截图选区
            </Button>
            <Button
              theme="borderless"
              size="small"
              className="ps-subtle-btn"
              onClick={resetHotkey}
            >
              恢复默认 (Alt + F2)
            </Button>
          </div>
        </section>

        {/* 卡片 2: 保存位置 */}
        <section className="ps-card">
          <div className="ps-card-header">
            <div className="ps-card-title-group">
              <span className="ps-card-icon"><IconFolderOpenStroked /></span>
              <span className="ps-card-title">截图保存位置</span>
            </div>
          </div>

          <div className="ps-path-box">
            <div className="ps-path-info">
              <span className="ps-path-icon"><IconFolderStroked /></span>
              <Tooltip content={displayDirectory} showArrow>
                <span className="ps-path-text">{displayDirectory}</span>
              </Tooltip>
            </div>
            <div className="ps-path-actions">
              {draft.saveDirectory && (
                <Button
                  theme="borderless"
                  size="small"
                  className="ps-subtle-btn"
                  onClick={resetDirectory}
                >
                  恢复桌面
                </Button>
              )}
              <Button
                theme="light"
                type="primary"
                size="small"
                icon={<IconFolderOpenStroked />}
                onClick={chooseDirectory}
              >
                选择文件夹
              </Button>
            </div>
          </div>

          <p className="ps-card-caption">
            在截图标注工具栏点击“保存”时,PNG 图像将写入此目录。日常选区无需占用磁盘。
          </p>
        </section>

        {/* 卡片 3: 行为与外观 */}
        <section className="ps-card">
          <div className="ps-card-header">
            <div className="ps-card-title-group">
              <span className="ps-card-icon"><IconSettingStroked /></span>
              <span className="ps-card-title">行为与外观</span>
            </div>
          </div>

          <div className="ps-setting-row">
            <div>
              <div className="ps-row-label">开机自启动</div>
              <div className="ps-row-desc">登录 Windows 后自动在后台就绪并驻留系统托盘</div>
            </div>
            <Switch
              checked={draft.autostart}
              onChange={checked => setDraft({ ...draft, autostart: checked })}
            />
          </div>

          <Divider margin="14px" className="ps-divider" />

          <div className="ps-setting-row">
            <div>
              <div className="ps-row-label">界面主题</div>
              <div className="ps-row-desc">选择清晰明亮的浅色风格、沉浸深色风格或跟随系统</div>
            </div>
            <div className="ps-theme-segmented">
              <button
                type="button"
                className={`ps-theme-tab ${draft.theme === 'system' ? 'active' : ''}`}
                onClick={() => handleThemeChange('system')}
              >
                <IconDesktop size="small" />
                <span>跟随系统</span>
              </button>
              <button
                type="button"
                className={`ps-theme-tab ${draft.theme === 'light' ? 'active' : ''}`}
                onClick={() => handleThemeChange('light')}
              >
                <IconSun size="small" />
                <span>浅色</span>
              </button>
              <button
                type="button"
                className={`ps-theme-tab ${draft.theme === 'dark' ? 'active' : ''}`}
                onClick={() => handleThemeChange('dark')}
              >
                <IconMoon size="small" />
                <span>深色</span>
              </button>
            </div>
          </div>
        </section>

        {/* 卡片 4: 截图历史 */}
        <section className="ps-card">
          <div className="ps-card-header">
            <div className="ps-card-title-group">
              <span className="ps-card-icon"><IconHistory /></span>
              <span className="ps-card-title">截图历史</span>
              <Tag size="small" color="violet" shape="circle">{historyItems.length}/3 张</Tag>
            </div>
            <Button
              theme="light"
              type="primary"
              size="small"
              loading={openingHistory}
              disabled={openingHistory}
              onClick={async () => {
                if (openingHistoryRef.current) return;
                openingHistoryRef.current = true;
                setOpeningHistory(true);
                try {
                  await showHistoryShelf();
                } catch (e) {
                  appToast.error('打开截图历史失败', e instanceof Error ? e.message : String(e));
                } finally {
                  openingHistoryRef.current = false;
                  setOpeningHistory(false);
                }
              }}
            >
              打开截图历史
            </Button>
          </div>

          <p className="ps-card-caption">
            PinShot 会在完成截图或取消时自动保留最近最多 3 张截图，便于随时追溯或贴图。
          </p>

          {historyItems.length > 0 ? (
            <div className="ps-settings-history-row">
              <div className="ps-settings-history-info">
                <span className="ps-settings-history-status">
                  最近截图: {historyItems[0].width} × {historyItems[0].height} px · {new Date(historyItems[0].timestamp).toLocaleTimeString()}
                </span>
                <span className="ps-settings-history-meta">
                  共记录 {historyItems.length} 张截图 (最多 3 张)
                </span>
              </div>
              <div className="ps-settings-history-actions">
                <Button
                  size="small"
                  theme="light"
                  icon={<IconPin size={13} />}
                  onClick={async () => {
                    try {
                      await restoreHistoryAsPin(historyItems[0].id);
                    } catch (e) {
                      appToast.error(e instanceof Error ? e.message : '贴图失败');
                    }
                  }}
                >
                  贴出最近
                </Button>
                <Button
                  size="small"
                  theme="light"
                  icon={<IconCopy />}
                  onClick={async () => {
                    try {
                      await copyHistoryToClipboard(historyItems[0].id);
                    } catch (e) {
                      appToast.error(e instanceof Error ? e.message : '复制失败');
                    }
                  }}
                >
                  复制
                </Button>
                <Button
                  size="small"
                  theme="borderless"
                  type="danger"
                  icon={<IconDelete />}
                  onClick={async () => {
                    try {
                      await clearHistory();
                      setHistoryItems([]);
                    } catch (e) {
                      appToast.error(e instanceof Error ? e.message : '清除失败');
                    }
                  }}
                >
                  清空
                </Button>
              </div>
            </div>
          ) : (
            <div className="ps-settings-history-empty">
              <span>当前暂无历史截图记录</span>
            </div>
          )}
        </section>

      </div>

      {/* 错误提示栏 */}
      {error && (
        <div className="ps-error-banner">
          <IconAlertTriangle />
          <span>{error}</span>
        </div>
      )}

      {/* 底部悬浮操作栏 */}
      <footer className="settings-footer">
        <div className="ps-footer-status">
          {isModified ? (
            <span className="ps-dirty-indicator">
              <span className="ps-dirty-dot" />
              有未保存的设置更改
            </span>
          ) : (
            <span className="ps-clean-indicator">
              所有配置已同步至本地
            </span>
          )}
        </div>

        <div className="ps-footer-actions">
          <Button
            theme="borderless"
            className="ps-cancel-btn"
            onClick={() => currentWindow().close()}
          >
            关闭
          </Button>
          <Button
            theme="solid"
            type="primary"
            icon={<IconSaveStroked />}
            loading={saving}
            disabled={!hasModifier}
            onClick={save}
            className="ps-save-btn"
          >
            保存设置
          </Button>
        </div>
      </footer>
    </main>
  );
}

function HotkeyRecorder({
  value,
  onChange,
}: {
  value: HotkeyBinding;
  onChange: (patch: Partial<HotkeyBinding>) => void;
}) {
  const [recording, setRecording] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      setRecording(false);
      return;
    }

    const key = event.key.toUpperCase();
    const isLetter = /^[A-Z]$/.test(key);
    const isDigit = /^[0-9]$/.test(key);
    const isFunction = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);

    const nextModifiers = {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      winKey: event.metaKey,
    };

    if (isLetter || isDigit || isFunction) {
      onChange({
        ...nextModifiers,
        key,
      });
      setRecording(false);
    } else {
      onChange(nextModifiers);
    }
  };

  const toggle = (field: keyof Pick<HotkeyBinding, 'ctrl' | 'alt' | 'shift' | 'winKey'>) => {
    onChange({ [field]: !value[field] });
  };

  const tokens = useMemo(() => {
    const list: string[] = [];
    if (value.ctrl) list.push('Ctrl');
    if (value.alt) list.push('Alt');
    if (value.shift) list.push('Shift');
    if (value.winKey) list.push('Win');
    if (value.key) list.push(value.key);
    return list;
  }, [value]);

  return (
    <div className="ps-hotkey-module">
      <div
        ref={captureRef}
        tabIndex={0}
        className={`ps-recorder-box ${recording ? 'is-recording' : ''}`}
        onClick={() => {
          setRecording(true);
          captureRef.current?.focus();
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
        role="button"
        aria-label="录制快捷键"
      >
        {recording ? (
          <div className="ps-recording-prompt">
            <span className="ps-recording-dot" />
            <span className="ps-recording-text">请在键盘上按下新的组合键 (按 Esc 取消)...</span>
          </div>
        ) : (
          <div className="ps-recorded-display">
            <div className="ps-keycaps-row">
              {tokens.length > 0 ? (
                tokens.map((token, i) => (
                  <React.Fragment key={i}>
                    <kbd className="ps-keycap">{token}</kbd>
                    {i < tokens.length - 1 && <span className="ps-keycap-plus">+</span>}
                  </React.Fragment>
                ))
              ) : (
                <span className="ps-keycap-empty">点击此处直接录制快捷键</span>
              )}
            </div>
            <span className="ps-click-hint">点击录制</span>
          </div>
        )}
      </div>

      <div className="ps-hotkey-adjust-bar">
        <div className="ps-mod-pills">
          {(['ctrl', 'alt', 'shift', 'winKey'] as const).map(field => {
            const active = Boolean(value[field]);
            const label = field === 'winKey' ? 'Win' : field[0].toUpperCase() + field.slice(1);
            return (
              <button
                key={field}
                type="button"
                className={`ps-mod-pill ${active ? 'active' : ''}`}
                onClick={() => toggle(field)}
                title={`点击切换 ${label}`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="ps-key-select-wrapper">
          <span className="ps-key-select-label">主键:</span>
          <Select
            value={value.key}
            onChange={v => onChange({ key: String(v) })}
            optionList={KEYS.map(k => ({ label: k, value: k }))}
            style={{ width: 104 }}
            className="ps-key-select"
          />
        </div>
      </div>
    </div>
  );
}
