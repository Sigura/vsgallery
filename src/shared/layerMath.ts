/** Geometry of layer placement: rectangles in image coordinates (x, y = top-left). */

export interface LRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Corner = 'nw' | 'ne' | 'se' | 'sw';

/**
 * Rectangle after dragging `corner` of `start` to (px, py) with the opposite corner fixed.
 * `keepAspect` keeps start's aspect ratio, following the axis that moved further. Sides stay ≥ 1.
 */
export function resizeByCorner(start: LRect, corner: Corner, px: number, py: number, keepAspect: boolean): LRect {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const ax = west ? start.x + start.w : start.x;
  const ay = north ? start.y + start.h : start.y;
  let w = Math.max(1, west ? ax - px : px - ax);
  let h = Math.max(1, north ? ay - py : py - ay);
  if (keepAspect) {
    const s = Math.max(w / start.w, h / start.h);
    w = Math.max(1, start.w * s);
    h = Math.max(1, start.h * s);
  }
  return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

/** Uniform scale ≤ 1 that makes w×h fit into maxW×maxH. */
export function fitScale(w: number, h: number, maxW: number, maxH: number): number {
  return Math.min(1, maxW / w, maxH / h);
}

export function flipRect(r: LRect, horizontal: boolean, docW: number, docH: number): LRect {
  return horizontal ? { ...r, x: docW - r.x - r.w } : { ...r, y: docH - r.y - r.h };
}

/** Placement after rotating a docW×docH document by 90°; the rotated document is docH×docW. */
export function rotateRect(r: LRect, clockwise: boolean, docW: number, docH: number): LRect {
  return clockwise ? { x: docH - r.y - r.h, y: r.x, w: r.h, h: r.w } : { x: r.y, y: docW - r.x - r.w, w: r.h, h: r.w };
}

export function intersectRect(a: LRect, b: LRect): LRect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : undefined;
}

export function unionRect(a: LRect, b: LRect): LRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
