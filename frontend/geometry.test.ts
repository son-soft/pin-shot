import { describe, expect, it } from 'vitest';
import { clampRect, contains, findSnappedWindow, normalizeRect, resizeFromHandle, snapPointToWindowEdges, translated } from './geometry';
import type { DetectedWindow } from './api';

describe('selection geometry', () => {
  it('normalizes a drag in every direction', () => expect(normalizeRect({ x: 90, y: 70 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 80, height: 50 }));
  it('keeps movement inside the virtual desktop image', () => expect(translated({ x: 10, y: 12, width: 40, height: 20 }, { x: -30, y: 80 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 80, width: 40, height: 20 }));
  it('resizes from the north-west handle and clamps', () => expect(resizeFromHandle({ x: 30, y: 30, width: 50, height: 40 }, 'nw', { x: -20, y: 10 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 10, width: 100, height: 60 }));
  it('detects points on the selection boundary', () => expect(contains({ x: 10, y: 10, width: 20, height: 20 }, { x: 30, y: 30 })).toBe(true));
  it('clamps oversized rectangles', () => expect(clampRect({ x: -2, y: 3, width: 120, height: 30 }, { width: 100, height: 50 })).toEqual({ x: 0, y: 3, width: 100, height: 30 }));
  it('resizes from the south-east handle inside offset bounds without jumping', () => {
    const bounds = { x: 500, y: 300, width: 800, height: 600 };
    const rect = { x: 600, y: 400, width: 100, height: 100 };
    const resized = resizeFromHandle(rect, 'se', { x: 750, y: 550 }, bounds);
    expect(resized).toEqual({ x: 600, y: 400, width: 150, height: 150 });
  });
  it('translates inside offset bounds without jumping', () => {
    const bounds = { x: 500, y: 300, width: 800, height: 600 };
    const rect = { x: 600, y: 400, width: 100, height: 100 };
    const moved = translated(rect, { x: 50, y: 50 }, bounds);
    expect(moved).toEqual({ x: 650, y: 450, width: 100, height: 100 });
  });
});

describe('window snapping geometry', () => {
  const mockWindows: DetectedWindow[] = [
    {
      id: 1,
      x: 100,
      y: 100,
      width: 800,
      height: 600,
      title: 'Browser',
    },
    {
      id: 2,
      parentId: 1,
      x: 120,
      y: 150,
      width: 300,
      height: 40,
      title: 'Address Bar',
    },
    {
      id: 3,
      x: 50,
      y: 50,
      width: 200,
      height: 200,
      title: 'Overlapped Background Window',
    },
  ];

  it('returns null when windows list is empty or point is outside', () => {
    expect(findSnappedWindow({ x: 10, y: 10 }, [])).toBeNull();
    expect(findSnappedWindow({ x: 1000, y: 1000 }, mockWindows)).toBeNull();
  });

  it('finds top-level window when inside bounds', () => {
    const snapped = findSnappedWindow({ x: 500, y: 400 }, mockWindows);
    expect(snapped).not.toBeNull();
    expect(snapped?.id).toBe(1);
    expect(snapped?.title).toBe('Browser');
  });

  it('prefers child control when pointer is inside both parent and child', () => {
    const snapped = findSnappedWindow({ x: 200, y: 160 }, mockWindows);
    expect(snapped).not.toBeNull();
    expect(snapped?.id).toBe(2);
    expect(snapped?.title).toBe('Address Bar');
  });

  it('prioritizes topmost window when overlapping', () => {
    // Both window 1 and window 3 overlap at (110, 110). Window 1 is topmost (index 0).
    const snapped = findSnappedWindow({ x: 110, y: 110 }, mockWindows);
    expect(snapped?.id).toBe(1);
  });

  it('snaps point to window edges within threshold', () => {
    // Window 1 is at x: 100, y: 100, width: 800, height: 600 (edges: left 100, right 900, top 100, bottom 700)
    // Point (104, 106) is within 8px of left (100) and top (100)
    const snapped = snapPointToWindowEdges({ x: 104, y: 106 }, mockWindows, 8);
    expect(snapped).toEqual({ x: 100, y: 100 });

    // Point near right edge (897, 300) -> snaps x to 900, y unchanged (300)
    const snappedRight = snapPointToWindowEdges({ x: 897, y: 300 }, mockWindows, 8);
    expect(snappedRight).toEqual({ x: 900, y: 300 });

    // Point far from any edge -> unchanged
    const farPoint = { x: 500, y: 400 };
    expect(snapPointToWindowEdges(farPoint, mockWindows, 8)).toEqual(farPoint);
  });
});
