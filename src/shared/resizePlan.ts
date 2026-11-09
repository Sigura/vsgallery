import { fitAspect, kohyaBuckets, nearestBucket, snapDown, type Size } from './buckets';

export type ResizeMode = 'bucket' | 'maxSide' | 'shortSide' | 'snap';

export interface ResizeOptions {
  mode: ResizeMode;
  /** Bucket mode: kohya base resolution (512 = SD1.5, 1024 = SDXL). */
  bucketBase: number;
  /** maxSide / shortSide modes: target length of that side. */
  size: number;
  /** Non-bucket modes: output sides are cropped down to multiples of this. */
  snap: number;
  /** Allow output larger than the source; otherwise such images are skipped. */
  upscale: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResizePlan =
  | { action: 'resize'; crop: Rect; out: Size; cropped: boolean; scaled: boolean }
  | { action: 'skip'; reason: 'unchanged' | 'upscale' | 'tooSmall' };

export function bucketsFor(base: number): Size[] {
  return kohyaBuckets(base, 256, base * 2, 64);
}

/** Centred crop of the source with the aspect ratio of `out` (rounded to whole pixels). */
function centredCrop(w: number, h: number, out: Size): Rect {
  const f = fitAspect(w, h, out.w / out.h);
  const cw = Math.min(w, Math.max(1, Math.round(f.w)));
  const ch = Math.min(h, Math.max(1, Math.round(f.h)));
  return { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch };
}

function finish(w: number, h: number, crop: Rect, out: Size, upscale: boolean): ResizePlan {
  const cropped = crop.w !== w || crop.h !== h;
  const scaled = out.w !== crop.w || out.h !== crop.h;
  if (!cropped && !scaled) return { action: 'skip', reason: 'unchanged' };
  if (!upscale && (out.w > crop.w || out.h > crop.h)) return { action: 'skip', reason: 'upscale' };
  return { action: 'resize', crop, out, cropped, scaled };
}

/**
 * What batch resize does to a w×h image. Bucket mode crops to the nearest kohya bucket's aspect
 * ratio and scales to the bucket; the other modes scale uniformly and then crop the sides down
 * to multiples of `snap`, centred.
 */
export function planResize(w: number, h: number, o: ResizeOptions, buckets: readonly Size[] = bucketsFor(o.bucketBase)): ResizePlan {
  if (o.mode === 'bucket') {
    const b = nearestBucket(w, h, buckets);
    return finish(w, h, centredCrop(w, h, b), { w: b.w, h: b.h }, o.upscale);
  }
  let s = 1;
  if (o.mode === 'maxSide') s = o.size / Math.max(w, h);
  else if (o.mode === 'shortSide') s = o.size / Math.min(w, h);
  // Shrink-only modes never enlarge an image that is already small enough.
  if (o.mode === 'maxSide' && s > 1 && !o.upscale) s = 1;
  const sw = Math.max(1, Math.round(w * s));
  const sh = Math.max(1, Math.round(h * s));
  const snap = Math.max(1, o.snap);
  if (sw < snap || sh < snap) return { action: 'skip', reason: 'tooSmall' };
  const out = { w: snapDown(sw, snap), h: snapDown(sh, snap) };
  // The source region that maps onto the snapped output at scale s.
  const cw = Math.min(w, Math.max(1, Math.round(out.w / s)));
  const ch = Math.min(h, Math.max(1, Math.round(out.h / s)));
  const crop = { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch };
  return finish(w, h, crop, out, o.upscale);
}
