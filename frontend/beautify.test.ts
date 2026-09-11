import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreset,
  BACKGROUND_PRESETS,
  BEAUTIFY_PRESETS,
  calculateBeautifiedDimensions,
  DEFAULT_BEAUTIFY_CONFIG,
  PADDING_OPTIONS,
  RADIUS_OPTIONS,
  renderBeautifiedCanvas,
  SHADOW_OPTIONS,
} from './beautify';

describe('Screenshot Beautify Presets & Options', () => {
  beforeEach(() => {
    // Mock HTMLCanvasElement getContext for jsdom environment
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      clip: vi.fn(),
      createLinearGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn(),
      }),
    });
  });
  it('should have only the 5 specified presets without emojis', () => {
    expect(BEAUTIFY_PRESETS.length).toBe(5);
    const presetIds = BEAUTIFY_PRESETS.map(p => p.id);
    expect(presetIds).toEqual(['classic', 'mint', 'midnight', 'minimal', 'none']);

    const presetNames = BEAUTIFY_PRESETS.map(p => p.name);
    expect(presetNames).toEqual(['经典', '薄荷', '暗夜', '极简', '无']);

    // Ensure no emojis exist in names or icons
    const emojiRegex = /\p{Extended_Pictographic}/u;
    for (const preset of BEAUTIFY_PRESETS) {
      expect(emojiRegex.test(preset.name)).toBe(false);
      if (preset.icon) {
        expect(emojiRegex.test(preset.icon)).toBe(false);
      }
    }
  });

  it('should have variety of background gradients including transparent', () => {
    expect(BACKGROUND_PRESETS.length).toBeGreaterThanOrEqual(5);
    const ids = BACKGROUND_PRESETS.map(b => b.id);
    expect(ids).toContain('purple-blue');
    expect(ids).toContain('mint');
    expect(ids).toContain('midnight');
    expect(ids).toContain('transparent');
  });

  it('should have radius, shadow, and padding options', () => {
    expect(RADIUS_OPTIONS.map(r => r.value)).toEqual([0, 12, 16]);
    expect(SHADOW_OPTIONS.map(s => s.value)).toEqual(['none', 'soft', 'deep']);
    expect(PADDING_OPTIONS.map(p => p.value)).toEqual([16, 48]);
  });

  it('applyPreset returns correct preset config', () => {
    const classic = applyPreset('classic');
    expect(classic.enabled).toBe(true);
    expect(classic.borderRadius).toBe(12);
    expect(classic.shadow).toBe('soft');
    expect(classic.windowHeader).toBe(true);
    expect(classic.padding).toBe(16);
    expect(classic.presetId).toBe('classic');

    const mint = applyPreset('mint');
    expect(mint.enabled).toBe(true);
    expect(mint.backgroundId).toBe('mint');

    const none = applyPreset('none');
    expect(none.enabled).toBe(false);
    expect(none.borderRadius).toBe(0);
    expect(none.shadow).toBe('none');

    const fallback = applyPreset('unknown-id');
    expect(fallback.presetId).toBe(DEFAULT_BEAUTIFY_CONFIG.presetId);
  });
});

describe('renderBeautifiedCanvas Dimensions', () => {
  it('returns exact original dimensions when disabled or none', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;

    const resDisabled = renderBeautifiedCanvas(canvas, {
      ...DEFAULT_BEAUTIFY_CONFIG,
      enabled: false,
    });
    expect(resDisabled.width).toBe(400);
    expect(resDisabled.height).toBe(300);

    const resNone = renderBeautifiedCanvas(canvas, applyPreset('none'));
    expect(resNone.width).toBe(400);
    expect(resNone.height).toBe(300);
  });

  it('correctly adds padding and titlebar height when enabled', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;

    const config = applyPreset('classic'); // padding: 16, windowHeader: true (32px)
    const res = renderBeautifiedCanvas(canvas, config);

    // width = 400 + 16 * 2 = 432
    // height = 300 + 32 (header) + 16 * 2 (padding) = 364
    expect(res.width).toBe(432);
    expect(res.height).toBe(364);
  });

  it('correctly calculates dimensions without window header', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 200;

    const config = {
      ...applyPreset('mint'),
      padding: 48,
      windowHeader: false,
    };
    const res = renderBeautifiedCanvas(canvas, config);

    // width = 500 + 48 * 2 = 596
    // height = 200 + 48 * 2 = 296
    expect(res.width).toBe(596);
    expect(res.height).toBe(296);
  });

  it('calculateBeautifiedDimensions gives precise offsets and sizes', () => {
    const dim = calculateBeautifiedDimensions(800, 600, applyPreset('classic'));
    expect(dim.width).toBe(800 + 16 * 2);
    expect(dim.height).toBe(600 + 32 + 16 * 2);
    expect(dim.innerX).toBe(16);
    expect(dim.innerY).toBe(16);
    expect(dim.headerHeight).toBe(32);

    const dimRaw = calculateBeautifiedDimensions(800, 600, applyPreset('none'));
    expect(dimRaw.width).toBe(800);
    expect(dimRaw.height).toBe(600);
    expect(dimRaw.innerX).toBe(0);
    expect(dimRaw.innerY).toBe(0);
  });
});
