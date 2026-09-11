export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function clampPoint(point: Point, width: number, height: number): Point {
  return { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) };
}

export function clampPointToBounds(
  point: Point,
  bounds: { x?: number; y?: number; width: number; height: number },
): Point {
  const minX = bounds.x ?? 0;
  const minY = bounds.y ?? 0;
  const maxX = minX + bounds.width;
  const maxY = minY + bounds.height;
  return {
    x: Math.max(minX, Math.min(maxX, point.x)),
    y: Math.max(minY, Math.min(maxY, point.y)),
  };
}

export function clampRect(rect: Rect, bounds: { x?: number; y?: number; width: number; height: number }): Rect {
  const minX = bounds.x ?? 0;
  const minY = bounds.y ?? 0;
  const maxX = minX + bounds.width;
  const maxY = minY + bounds.height;

  const width = Math.max(0, Math.min(rect.width, bounds.width));
  const height = Math.max(0, Math.min(rect.height, bounds.height));
  const x = Math.max(minX, Math.min(maxX - width, rect.x));
  const y = Math.max(minY, Math.min(maxY - height, rect.y));
  return { x, y, width, height };
}

export function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function translated(rect: Rect, delta: Point, bounds: { x?: number; y?: number; width: number; height: number }): Rect {
  return clampRect({ ...rect, x: rect.x + delta.x, y: rect.y + delta.y }, bounds);
}

export function cropRect(rect: Rect, max: { x?: number; y?: number; width: number; height: number }): Rect {
  const minX = max.x ?? 0;
  const minY = max.y ?? 0;
  const maxX = minX + max.width;
  const maxY = minY + max.height;

  const x = Math.round(Math.max(minX, Math.min(maxX - 1, rect.x)));
  const y = Math.round(Math.max(minY, Math.min(maxY - 1, rect.y)));
  const width = Math.max(1, Math.min(maxX - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(maxY - y, Math.round(rect.height)));
  return { x, y, width, height };
}

export function handleAt(rect: Rect, point: Point, radius = 12): string | null {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const handles: Record<string, Point> = {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    sw: { x: rect.x, y: rect.y + rect.height },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
    n: { x: midX, y: rect.y },
    s: { x: midX, y: rect.y + rect.height },
    w: { x: rect.x, y: midY },
    e: { x: rect.x + rect.width, y: midY },
  };
  for (const [name, handle] of Object.entries(handles)) {
    if (Math.abs(point.x - handle.x) <= radius && Math.abs(point.y - handle.y) <= radius) return name;
  }
  return null;
}

export function resizeFromHandle(rect: Rect, handle: string, point: Point, bounds: { x?: number; y?: number; width: number; height: number }): Rect {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const hasW = handle.includes('w');
  const hasE = handle.includes('e');
  const hasN = handle.includes('n');
  const hasS = handle.includes('s');

  const x = hasW ? Math.min(point.x, right - 6) : rect.x;
  const y = hasN ? Math.min(point.y, bottom - 6) : rect.y;

  let width = rect.width;
  if (hasW) {
    width = right - Math.min(point.x, right - 6);
  } else if (hasE) {
    width = Math.max(6, point.x - rect.x);
  }

  let height = rect.height;
  if (hasN) {
    height = bottom - Math.min(point.y, bottom - 6);
  } else if (hasS) {
    height = Math.max(6, point.y - rect.y);
  }

  return clampRect({ x, y, width, height }, bounds);
}

export function findSnappedWindow(
  point: Point,
  windows?: { id: number; parentId?: number | null; x: number; y: number; width: number; height: number; title?: string | null }[],
): { id: number; parentId?: number | null; x: number; y: number; width: number; height: number; title?: string | null } | null {
  if (!windows || windows.length === 0) return null;

  // 1. Find the topmost top-level window (in Z-order) containing the point
  let topWindow: typeof windows[0] | null = null;
  for (const win of windows) {
    if (!win.parentId && contains(win, point)) {
      topWindow = win;
      break;
    }
  }

  // 2. If a top-level window was found, see if any of its child controls contain the point
  if (topWindow) {
    let bestChild: typeof windows[0] | null = null;
    let minArea = Infinity;
    for (const win of windows) {
      if (win.parentId === topWindow.id && contains(win, point)) {
        const area = win.width * win.height;
        if (area < minArea) {
          minArea = area;
          bestChild = win;
        }
      }
    }
    return bestChild || topWindow;
  }

  // 3. Fallback: smallest window of any kind containing the point
  let fallback: typeof windows[0] | null = null;
  let minArea = Infinity;
  for (const win of windows) {
    if (contains(win, point)) {
      const area = win.width * win.height;
      if (area < minArea) {
        minArea = area;
        fallback = win;
      }
    }
  }
  return fallback;
}

export function snapPointToWindowEdges(
  point: Point,
  windows?: { x: number; y: number; width: number; height: number }[],
  threshold = 8,
): Point {
  if (!windows || windows.length === 0) return point;
  let bestX = point.x;
  let bestY = point.y;
  let minDistX = threshold + 1;
  let minDistY = threshold + 1;

  for (const win of windows) {
    const leftDist = Math.abs(point.x - win.x);
    if (leftDist < minDistX) {
      minDistX = leftDist;
      bestX = win.x;
    }
    const rightDist = Math.abs(point.x - (win.x + win.width));
    if (rightDist < minDistX) {
      minDistX = rightDist;
      bestX = win.x + win.width;
    }

    const topDist = Math.abs(point.y - win.y);
    if (topDist < minDistY) {
      minDistY = topDist;
      bestY = win.y;
    }
    const bottomDist = Math.abs(point.y - (win.y + win.height));
    if (bottomDist < minDistY) {
      minDistY = bottomDist;
      bestY = win.y + win.height;
    }
  }

  return { x: bestX, y: bestY };
}
