export type ShadowPreset = 'none' | 'soft' | 'mac' | 'deep';

export interface BackgroundPreset {
  id: string;
  name: string;
  type: 'gradient' | 'solid' | 'transparent';
  value: string;
  colors: [string, string];
  darkHeader?: boolean;
}

export interface BeautifyConfig {
  enabled: boolean;
  presetId: string;
  borderRadius: number; // 0, 8, 12, 16, 24
  shadow: ShadowPreset;
  padding: number; // 16, 24, 32, 48, 64
  backgroundId: string;
  customGradient?: [string, string];
  windowHeader: boolean;
  windowHeaderStyle: 'mac-light' | 'mac-dark';
}

export interface BeautifyPreset {
  id: string;
  name: string;
  icon?: string;
  description: string;
  config: Omit<BeautifyConfig, 'presetId'>;
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'purple-blue',
    name: '经典紫蓝',
    type: 'gradient',
    value: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
    colors: ['#6366f1', '#a855f7'],
  },
  {
    id: 'mint',
    name: '清新薄荷',
    type: 'gradient',
    value: 'linear-gradient(135deg, #059669 0%, #34d399 100%)',
    colors: ['#059669', '#34d399'],
  },
  {
    id: 'midnight',
    name: '深邃暗夜',
    type: 'gradient',
    value: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
    colors: ['#1e293b', '#0f172a'],
    darkHeader: true,
  },
  {
    id: 'minimal',
    name: '极简浅灰',
    type: 'gradient',
    value: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
    colors: ['#f8fafc', '#e2e8f0'],
  },
  {
    id: 'transparent',
    name: '通透透明',
    type: 'transparent',
    value: 'transparent',
    colors: ['transparent', 'transparent'],
  },
  {
    id: 'sunset',
    name: '暮光霞光',
    type: 'gradient',
    value: 'linear-gradient(135deg, #f43f5e 0%, #fb923c 100%)',
    colors: ['#f43f5e', '#fb923c'],
  },
  {
    id: 'ocean',
    name: '碧海晴空',
    type: 'gradient',
    value: 'linear-gradient(135deg, #0284c7 0%, #22d3ee 100%)',
    colors: ['#0284c7', '#22d3ee'],
  },
  {
    id: 'cyber',
    name: '霓虹赛博',
    type: 'gradient',
    value: 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
    colors: ['#8b5cf6', '#ec4899'],
  },
  {
    id: 'aurora',
    name: '极光碧绿',
    type: 'gradient',
    value: 'linear-gradient(135deg, #3b82f6 0%, #10b981 100%)',
    colors: ['#3b82f6', '#10b981'],
  },
];

export const BEAUTIFY_PRESETS: BeautifyPreset[] = [
  {
    id: 'classic',
    name: '经典',
    description: '经典紫蓝渐变 + 12px 圆角 + 柔光阴影 + 控制栏',
    config: {
      enabled: true,
      borderRadius: 12,
      shadow: 'soft',
      padding: 16,
      backgroundId: 'purple-blue',
      windowHeader: true,
      windowHeaderStyle: 'mac-light',
    },
  },
  {
    id: 'mint',
    name: '薄荷',
    description: '翠绿渐变 + 12px 圆角 + 优雅阴影 + 窗口栏',
    config: {
      enabled: true,
      borderRadius: 12,
      shadow: 'soft',
      padding: 16,
      backgroundId: 'mint',
      windowHeader: true,
      windowHeaderStyle: 'mac-light',
    },
  },
  {
    id: 'midnight',
    name: '暗夜',
    description: '深邃暗色渐变 + 12px 圆角 + 立体深阴影 + 深色窗口栏',
    config: {
      enabled: true,
      borderRadius: 12,
      shadow: 'deep',
      padding: 16,
      backgroundId: 'midnight',
      windowHeader: true,
      windowHeaderStyle: 'mac-dark',
    },
  },
  {
    id: 'minimal',
    name: '极简',
    description: '素雅浅灰微渐变 + 12px 圆角 + 轻柔阴影',
    config: {
      enabled: true,
      borderRadius: 12,
      shadow: 'soft',
      padding: 16,
      backgroundId: 'minimal',
      windowHeader: true,
      windowHeaderStyle: 'mac-light',
    },
  },
  {
    id: 'none',
    name: '无',
    description: '关闭美化，保留原始截图像素与尺寸',
    config: {
      enabled: false,
      borderRadius: 0,
      shadow: 'none',
      padding: 0,
      backgroundId: 'transparent',
      windowHeader: false,
      windowHeaderStyle: 'mac-light',
    },
  },
];

export const DEFAULT_BEAUTIFY_CONFIG: BeautifyConfig = {
  enabled: false,
  presetId: 'classic',
  borderRadius: 12,
  shadow: 'soft',
  padding: 16,
  backgroundId: 'purple-blue',
  windowHeader: true,
  windowHeaderStyle: 'mac-light',
};

export const RADIUS_OPTIONS = [
  { label: '0px', value: 0 },
  { label: '12px', value: 12 },
  { label: '16px', value: 16 },
];

export const SHADOW_OPTIONS: { label: string; value: ShadowPreset }[] = [
  { label: '无', value: 'none' },
  { label: '轻柔', value: 'soft' },
  { label: '深邃', value: 'deep' },
];

export const PADDING_OPTIONS = [
  { label: '16', value: 16 },
  { label: '48', value: 48 },
];

export function applyPreset(presetId: string): BeautifyConfig {
  const normalized = presetId === 'mac-classic' ? 'classic' : presetId;
  const preset = BEAUTIFY_PRESETS.find(p => p.id === normalized);
  if (!preset) return { ...DEFAULT_BEAUTIFY_CONFIG };
  return {
    ...preset.config,
    presetId: preset.id,
  };
}

export function calculateBeautifiedDimensions(
  sourceWidth: number,
  sourceHeight: number,
  config: BeautifyConfig,
): {
  width: number;
  height: number;
  innerX: number;
  innerY: number;
  winWidth: number;
  winHeight: number;
  headerHeight: number;
} {
  if (!config.enabled || config.presetId === 'none') {
    return {
      width: sourceWidth,
      height: sourceHeight,
      innerX: 0,
      innerY: 0,
      winWidth: sourceWidth,
      winHeight: sourceHeight,
      headerHeight: 0,
    };
  }
  const headerHeight = config.windowHeader ? 32 : 0;
  const padding = Math.max(0, config.padding);
  const winWidth = sourceWidth;
  const winHeight = sourceHeight + headerHeight;
  return {
    width: winWidth + padding * 2,
    height: winHeight + padding * 2,
    innerX: padding,
    innerY: padding,
    winWidth,
    winHeight,
    headerHeight,
  };
}

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function drawTrafficLight(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fillColor: string,
  strokeColor: string,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.lineWidth = 0.75;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();
  ctx.restore();
}

/**
 * Renders the outer beautified backdrop (gradient/solid background and drop shadow)
 * around an inner rectangle.
 */
export function drawBeautifiedBackdrop(
  ctx: CanvasRenderingContext2D,
  innerRect: { x: number; y: number; width: number; height: number },
  config: BeautifyConfig,
) {
  if (!config.enabled || config.presetId === 'none') return;
  const headerHeight = config.windowHeader ? 32 : 0;
  const padding = Math.max(0, config.padding);
  const radius = Math.max(0, config.borderRadius);
  const winX = innerRect.x;
  const winY = innerRect.y - headerHeight;
  const winWidth = innerRect.width;
  const winHeight = innerRect.height + headerHeight;
  const bgX = winX - padding;
  const bgY = winY - padding;
  const bgWidth = winWidth + padding * 2;
  const bgHeight = winHeight + padding * 2;

  ctx.save();

  // 1. Draw Background
  const bgPreset = BACKGROUND_PRESETS.find(b => b.id === config.backgroundId) || BACKGROUND_PRESETS[0];
  if (bgPreset.type === 'gradient') {
    const grad = ctx.createLinearGradient(bgX, bgY, bgX + bgWidth, bgY + bgHeight);
    const colors = config.customGradient || bgPreset.colors;
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
  } else if (bgPreset.type === 'solid') {
    ctx.fillStyle = bgPreset.value;
    ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
  }

  // 2. Draw Drop Shadow under the window
  if (config.shadow !== 'none') {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Renders the macOS window header bar with traffic lights (red, yellow, green)
 * on top of the window content.
 */
export function drawBeautifiedHeader(
  ctx: CanvasRenderingContext2D,
  innerRect: { x: number; y: number; width: number; height: number },
  config: BeautifyConfig,
) {
  if (!config.enabled || config.presetId === 'none' || !config.windowHeader) return;
  const headerHeight = 32;
  const radius = Math.max(0, config.borderRadius);
  const winX = innerRect.x;
  const winY = innerRect.y - headerHeight;
  const winWidth = innerRect.width;
  const winHeight = innerRect.height + headerHeight;

  ctx.save();
  drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
  ctx.clip();

  const bgPreset = BACKGROUND_PRESETS.find(b => b.id === config.backgroundId) || BACKGROUND_PRESETS[0];
  const isDark = config.windowHeaderStyle === 'mac-dark' || bgPreset.darkHeader;
  ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
  ctx.fillRect(winX, winY, winWidth, headerHeight);

  // Traffic light dots
  const dotY = winY + headerHeight / 2;
  const r = 5;
  const startX = winX + 16;
  drawTrafficLight(ctx, startX, dotY, r, '#ff5f56', '#e0443e');
  drawTrafficLight(ctx, startX + 16, dotY, r, '#ffbd2e', '#dea125');
  drawTrafficLight(ctx, startX + 32, dotY, r, '#27c93f', '#1aab29');
  ctx.restore();
}

/**
 * Renders the full outer beautified frame around an inner rectangle.
 */
export function drawBeautifiedFrame(
  ctx: CanvasRenderingContext2D,
  innerRect: { x: number; y: number; width: number; height: number },
  config: BeautifyConfig,
) {
  drawBeautifiedBackdrop(ctx, innerRect, config);
  drawBeautifiedHeader(ctx, innerRect, config);
}


/**
 * Renders a beautified screenshot onto a canvas with rounded corners,
 * multi-layered Mac drop shadow, background gradient/color, and optional macOS traffic light bar.
 */
export function renderBeautifiedCanvas(
  sourceCanvas: HTMLCanvasElement,
  config: BeautifyConfig,
): HTMLCanvasElement {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;

  // If beautify is not active, return a copy of the raw source
  if (!config.enabled || config.presetId === 'none') {
    const copy = document.createElement('canvas');
    copy.width = sourceWidth;
    copy.height = sourceHeight;
    const copyCtx = copy.getContext('2d');
    if (copyCtx) {
      copyCtx.drawImage(sourceCanvas, 0, 0);
    }
    return copy;
  }

  const headerHeight = config.windowHeader ? 32 : 0;
  const winWidth = sourceWidth;
  const winHeight = sourceHeight + headerHeight;
  const padding = Math.max(0, config.padding);
  const totalWidth = winWidth + padding * 2;
  const totalHeight = winHeight + padding * 2;

  const target = document.createElement('canvas');
  target.width = totalWidth;
  target.height = totalHeight;
  const ctx = target.getContext('2d');
  if (!ctx) return target;

  const winX = padding;
  const winY = padding;
  const radius = Math.max(0, config.borderRadius);

  // 1. Draw Background
  const bgPreset = BACKGROUND_PRESETS.find(b => b.id === config.backgroundId) || BACKGROUND_PRESETS[0];
  if (bgPreset.type === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, totalWidth, totalHeight);
    const colors = config.customGradient || bgPreset.colors;
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, totalWidth, totalHeight);
  } else if (bgPreset.type === 'solid') {
    ctx.fillStyle = bgPreset.value;
    ctx.fillRect(0, 0, totalWidth, totalHeight);
  } else {
    // transparent
    ctx.clearRect(0, 0, totalWidth, totalHeight);
  }

  // 2. Draw Mac Drop Shadow
  if (config.shadow !== 'none') {
    if (config.shadow === 'soft') {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.16)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
      ctx.fill();
      ctx.restore();
    } else if (config.shadow === 'mac') {
      // Layer 1: Ambient diffusion
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
      ctx.shadowBlur = 38;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 16;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
      ctx.fill();
      ctx.restore();

      // Layer 2: Key directional drop shadow
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
      ctx.fill();
      ctx.restore();
    } else if (config.shadow === 'deep') {
      // Layer 1: Wide dark ambient
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 52;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 24;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
      ctx.fill();
      ctx.restore();

      // Layer 2: Dense inner shadow
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
      ctx.fill();
      ctx.restore();
    }
  }

  // 3. Rounded Window Content Clipping & Header
  ctx.save();
  drawRoundedRect(ctx, winX, winY, winWidth, winHeight, radius);
  ctx.clip();

  // Solid base inside window so shadow doesn't shine through
  ctx.fillStyle = config.windowHeaderStyle === 'mac-dark' ? '#1e2025' : '#ffffff';
  ctx.fillRect(winX, winY, winWidth, winHeight);

  if (config.windowHeader) {
    const isDark = config.windowHeaderStyle === 'mac-dark';
    // Titlebar background
    ctx.fillStyle = isDark ? '#26282d' : '#f1f2f6';
    ctx.fillRect(winX, winY, winWidth, headerHeight);

    // Titlebar bottom border
    ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(winX, winY + headerHeight - 1, winWidth, 1);

    // Three traffic light buttons
    const dotY = winY + headerHeight / 2;
    const dotR = 5.5;
    const startX = winX + 16;
    const gap = 8;
    const step = dotR * 2 + gap;

    // Close (Red)
    drawTrafficLight(ctx, startX, dotY, dotR, '#ff5f56', '#e0443e');
    // Minimize (Yellow)
    drawTrafficLight(ctx, startX + step, dotY, dotR, '#ffbd2e', '#dea123');
    // Maximize (Green)
    drawTrafficLight(ctx, startX + step * 2, dotY, dotR, '#27c93f', '#1aab29');

    // Draw screenshot content
    ctx.drawImage(sourceCanvas, winX, winY + headerHeight, sourceWidth, sourceHeight);
  } else {
    // Draw screenshot directly
    ctx.drawImage(sourceCanvas, winX, winY, sourceWidth, sourceHeight);
  }
  ctx.restore();

  // 4. Subtle Outer Window Rim Border
  if (radius > 0 || config.windowHeader) {
    ctx.save();
    ctx.strokeStyle =
      config.windowHeaderStyle === 'mac-dark'
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(0, 0, 0, 0.1)';
    ctx.lineWidth = 1;
    drawRoundedRect(ctx, winX + 0.5, winY + 0.5, winWidth - 1, winHeight - 1, radius);
    ctx.stroke();
    ctx.restore();
  }

  return target;
}
