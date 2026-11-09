/** Selection masks: one byte per pixel (1 = selected), row-major, in image coordinates. */

export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MaskOp = 'replace' | 'add' | 'subtract';

/**
 * Contiguous region (4-connected) around (sx, sy) whose pixels differ from the seed pixel by at
 * most `tolerance` in every RGBA channel.
 */
export function floodFill(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, sx: number, sy: number, tolerance: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const s = (sy * w + sx) * 4;
  const r0 = rgba[s];
  const g0 = rgba[s + 1];
  const b0 = rgba[s + 2];
  const a0 = rgba[s + 3];
  const match = (i: number) => {
    const p = i * 4;
    return (
      Math.abs(rgba[p] - r0) <= tolerance &&
      Math.abs(rgba[p + 1] - g0) <= tolerance &&
      Math.abs(rgba[p + 2] - b0) <= tolerance &&
      Math.abs(rgba[p + 3] - a0) <= tolerance
    );
  };
  // Scanline fill: each stack entry is a pixel whose row span is filled and whose neighbours above/below are queued.
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const row = y * w;
    if (mask[row + x] || !match(row + x)) continue;
    let x0 = x;
    while (x0 > 0 && !mask[row + x0 - 1] && match(row + x0 - 1)) x0--;
    let x1 = x;
    while (x1 < w - 1 && !mask[row + x1 + 1] && match(row + x1 + 1)) x1++;
    mask.fill(1, row + x0, row + x1 + 1);
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let nx = x0; nx <= x1; nx++) {
        const ok = !mask[nrow + nx] && match(nrow + nx);
        if (ok && !inRun) stack.push(nx, ny);
        inRun = ok;
      }
    }
  }
  return mask;
}

export function rectMask(w: number, h: number, r: MaskRect): Uint8Array {
  const mask = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(w, Math.round(r.x + r.w));
  const y1 = Math.min(h, Math.round(r.y + r.h));
  for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + Math.max(x0, x1));
  return mask;
}

/** Even-odd polygon fill; a pixel is inside when its centre is. */
export function polygonMask(w: number, h: number, pts: readonly { x: number; y: number }[]): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (pts.length < 3) return mask;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const xs: number[] = [];
  for (let y = Math.max(0, Math.floor(minY)); y < Math.min(h, Math.ceil(maxY)); y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a.y <= cy === b.y <= cy) continue;
      xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Pixel x is inside when xs[i] <= x + 0.5 < xs[i + 1].
      const x0 = Math.max(0, Math.ceil(xs[i] - 0.5));
      const x1 = Math.min(w, Math.ceil(xs[i + 1] - 0.5));
      if (x1 > x0) mask.fill(1, y * w + x0, y * w + x1);
    }
  }
  return mask;
}

export function combineMasks(base: Uint8Array | undefined, shape: Uint8Array, op: MaskOp): Uint8Array {
  if (op === 'replace' || !base) return op === 'subtract' ? new Uint8Array(shape.length) : shape;
  const out = new Uint8Array(base);
  if (op === 'add') for (let i = 0; i < out.length; i++) out[i] |= shape[i];
  else for (let i = 0; i < out.length; i++) if (shape[i]) out[i] = 0;
  return out;
}

export function invertMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

export function maskBounds(mask: Uint8Array, w: number, h: number): MaskRect | undefined {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    x0 = Math.min(x0, first);
    x1 = Math.max(x1, last);
    y0 = Math.min(y0, y);
    y1 = y;
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Boundary between selected and unselected pixels as axis-aligned segments
 * [x0, y0, x1, y1, …] in pixel-edge coordinates; collinear neighbours are merged.
 */
export function maskOutline(mask: Uint8Array, w: number, h: number): number[] {
  const out: number[] = [];
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  // Horizontal edges at y = 0..h, between rows y-1 and y.
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && at(x, y - 1) !== at(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        out.push(start, y, x, y);
        start = -1;
      }
    }
  }
  // Vertical edges at x = 0..w, between columns x-1 and x.
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && at(x - 1, y) !== at(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        out.push(x, start, x, y);
        start = -1;
      }
    }
  }
  return out;
}
