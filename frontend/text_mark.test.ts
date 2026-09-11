import { describe, expect, it } from 'vitest';

describe('text mark hit-testing and bounds', () => {
  function findTextMarkAtPoint(point: { x: number; y: number }, marks: Array<{ id: number; kind: string; rect: { x: number; y: number; width: number; height: number }; text?: string; fontSize?: number }>) {
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i];
      if (mark.kind === 'text' && mark.text && mark.text.trim().length > 0) {
        const fontSize = mark.fontSize || 24;
        const lh = Math.round(fontSize * 1.32);
        const lineHeight = (lh - fontSize) % 2 !== 0 ? lh + 1 : lh;
        const lines = mark.text.split('\n');
        const width = Math.max(mark.rect.width, 40);
        const height = Math.max(mark.rect.height, lines.length * lineHeight);
        if (
          point.x >= mark.rect.x - 4 &&
          point.x <= mark.rect.x + width + 4 &&
          point.y >= mark.rect.y - 4 &&
          point.y <= mark.rect.y + height + 4
        ) {
          return mark;
        }
      }
    }
    return undefined;
  }

  it('detects click inside text mark', () => {
    const marks = [
      {
        id: 1,
        kind: 'text',
        rect: { x: 100, y: 100, width: 120, height: 32 },
        text: '测试文本',
        fontSize: 24,
      },
    ];

    expect(findTextMarkAtPoint({ x: 110, y: 110 }, marks)?.id).toBe(1);
    expect(findTextMarkAtPoint({ x: 98, y: 98 }, marks)?.id).toBe(1);
    expect(findTextMarkAtPoint({ x: 50, y: 50 }, marks)).toBeUndefined();
    expect(findTextMarkAtPoint({ x: 300, y: 300 }, marks)).toBeUndefined();
  });

  it('prioritizes topmost text mark when overlapping', () => {
    const marks = [
      {
        id: 1,
        kind: 'text',
        rect: { x: 100, y: 100, width: 120, height: 32 },
        text: '底文字',
        fontSize: 24,
      },
      {
        id: 2,
        kind: 'text',
        rect: { x: 110, y: 105, width: 120, height: 32 },
        text: '顶文字',
        fontSize: 24,
      },
    ];

    expect(findTextMarkAtPoint({ x: 115, y: 115 }, marks)?.id).toBe(2);
  });

  it('ignores empty text marks', () => {
    const marks = [
      {
        id: 1,
        kind: 'text',
        rect: { x: 100, y: 100, width: 120, height: 32 },
        text: '   ',
        fontSize: 24,
      },
    ];

    expect(findTextMarkAtPoint({ x: 110, y: 110 }, marks)).toBeUndefined();
  });

  it('correctly handles deletion and filtering of empty marks', () => {
    const marks = [
      { id: 1, kind: 'text', rect: { x: 10, y: 10, width: 50, height: 20 }, text: '保留' },
      { id: 2, kind: 'text', rect: { x: 100, y: 100, width: 50, height: 20 }, text: '' },
    ];
    const filtered = marks.filter(m => m.text && m.text.trim().length > 0);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe(1);
  });

  it('calculates larger padding for fill/bubble style', () => {
    function getPads(scaleX: number, bgStyle: 'none' | 'fill' = 'none') {
      const padX = (bgStyle === 'fill' ? 12 : 7.5) / scaleX;
      const padY = (bgStyle === 'fill' ? 8 : 5.5) / scaleX;
      return { padX, padY };
    }

    const plain = getPads(1, 'none');
    const bubble = getPads(1, 'fill');

    expect(bubble.padX).toBeGreaterThan(plain.padX);
    expect(bubble.padY).toBeGreaterThan(plain.padY);
    expect(bubble.padX).toBe(12);
    expect(bubble.padY).toBe(8);
  });

  it('converts hex to translucent rgba for highlighter', () => {
    function hexToRgba(hex: string, alpha: number): string {
      if (!hex || !hex.startsWith('#') || hex.length < 7) {
        return `rgba(250, 204, 21, ${alpha})`;
      }
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    expect(hexToRgba('#facc15', 0.38)).toBe('rgba(250, 204, 21, 0.38)');
    expect(hexToRgba('#4ade80', 0.5)).toBe('rgba(74, 222, 128, 0.5)');
    expect(hexToRgba('invalid', 0.38)).toBe('rgba(250, 204, 21, 0.38)');
  });

  it('computes next step number automatically and supports manual reset', () => {
    function getNextStepNumber(
      marks: Array<{ kind: string; step?: number }>,
      manualNextStep?: number | null,
    ): number {
      if (manualNextStep !== undefined && manualNextStep !== null) {
        return manualNextStep;
      }
      const stepMarks = marks.filter(m => m.kind === 'step');
      if (stepMarks.length === 0) return 1;
      const maxStep = stepMarks.reduce((max, m) => Math.max(max, m.step || 0), 0);
      return maxStep + 1;
    }

    expect(getNextStepNumber([])).toBe(1);
    expect(getNextStepNumber([{ kind: 'step', step: 1 }])).toBe(2);
    expect(getNextStepNumber([{ kind: 'step', step: 1 }, { kind: 'step', step: 3 }])).toBe(4);
    expect(getNextStepNumber([{ kind: 'step', step: 1 }, { kind: 'step', step: 2 }], 1)).toBe(1);
  });

  it('detects click inside circular step mark', () => {
    function findMovableMarkAtPoint(
      point: { x: number; y: number },
      marks: Array<{
        id: number;
        kind: string;
        rect: { x: number; y: number; width: number; height: number };
        step?: number;
      }>,
    ) {
      for (let i = marks.length - 1; i >= 0; i--) {
        const mark = marks[i];
        if (mark.kind === 'step') {
          const cx = mark.rect.x + mark.rect.width / 2;
          const cy = mark.rect.y + mark.rect.height / 2;
          const radius = mark.rect.width / 2;
          const dist = Math.hypot(point.x - cx, point.y - cy);
          if (dist <= radius + 4) {
            return mark;
          }
        }
      }
      return undefined;
    }

    const marks = [
      {
        id: 10,
        kind: 'step',
        rect: { x: 80, y: 80, width: 40, height: 40 },
        step: 1,
      },
    ];

    expect(findMovableMarkAtPoint({ x: 100, y: 100 }, marks)?.id).toBe(10);
    expect(findMovableMarkAtPoint({ x: 115, y: 110 }, marks)?.id).toBe(10);
    expect(findMovableMarkAtPoint({ x: 140, y: 140 }, marks)).toBeUndefined();
  });

  it('calculates bounding box for freehand brush stroke points', () => {
    function computeBrushBounds(pts: Array<{ x: number; y: number }>, lineWidth = 4) {
      if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
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
      const pad = Math.ceil(lineWidth / 2) + 2;
      return {
        x: Math.max(0, minX - pad),
        y: Math.max(0, minY - pad),
        width: Math.max(1, maxX - minX + pad * 2),
        height: Math.max(1, maxY - minY + pad * 2),
      };
    }

    const points = [
      { x: 10, y: 20 },
      { x: 50, y: 80 },
      { x: 100, y: 40 },
    ];
    const bounds = computeBrushBounds(points, 4);
    expect(bounds.x).toBe(6);
    expect(bounds.y).toBe(16);
    expect(bounds.width).toBe(98);
    expect(bounds.height).toBe(68);
  });

  it('calculates balanced vertical padding for text box across all font sizes', () => {
    function getTextLineHeight(fontSize: number): number {
      const lh = Math.round(fontSize * 1.32);
      return (lh - fontSize) % 2 !== 0 ? lh + 1 : lh;
    }

    function measureTextHeight(linesCount: number, fontSize: number, padY: number) {
      const lineHeight = getTextLineHeight(fontSize);
      return Math.max(lineHeight + padY * 2, linesCount * lineHeight + padY * 2);
    }

    const testSizes = [16, 24, 32, 42];
    for (const fontSize of testSizes) {
      const lineHeight = getTextLineHeight(fontSize);
      const halfLeading = (lineHeight - fontSize) / 2;
      expect(Number.isInteger(halfLeading)).toBe(true);

      const padY = 8;
      const h1 = measureTextHeight(1, fontSize, padY);
      expect(h1).toBe(lineHeight + padY * 2);
      const topGap = padY + halfLeading;
      const bottomGap = h1 - (padY + halfLeading + fontSize);
      expect(bottomGap).toBe(topGap);

      const h2 = measureTextHeight(2, fontSize, padY);
      expect(h2).toBe(2 * lineHeight + padY * 2);
      const bottomGap2 = h2 - (padY + halfLeading + lineHeight + fontSize);
      expect(bottomGap2).toBe(topGap);
    }
  });
});
