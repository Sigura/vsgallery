import { clampRect, type PaintSurface, type Rect } from './document';

export interface BrushSettings {
  /** Diameter in screen pixels (used when sizeMode is 'screen'). */
  sizeScreen: number;
  /** Diameter in image pixels (used when sizeMode is 'image'). */
  sizeImage: number;
  sizeMode: 'screen' | 'image';
  hardness: number;
  opacity: number;
  flow: number;
  /** Distance between dabs as a fraction of the diameter. */
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  color: string;
}

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

const TEX = 256;
const textures = new Map<string, OffscreenCanvas>();

/** Radial dab: fully opaque up to `hardness`·radius, fading to transparent at the radius. */
export function dabTexture(color: string, hardness: number): OffscreenCanvas {
  const key = `${color}|${hardness.toFixed(2)}`;
  let t = textures.get(key);
  if (t) return t;
  t = new OffscreenCanvas(TEX, TEX);
  const g = t.getContext('2d')!;
  const r = TEX / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(Math.min(0.999, hardness), color);
  grad.addColorStop(1, `${color}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, TEX, TEX);
  if (textures.size > 32) textures.delete(textures.keys().next().value as string);
  textures.set(key, t);
  return t;
}

/**
 * One brush or eraser stroke. Dabs accumulate in a separate buffer with `flow` alpha; the buffer
 * is composited onto the stroke-start pixels with `opacity`, so overlapping dabs never exceed
 * the opacity (Krita-style flow/opacity). Only the touched rectangle is restored and redrawn.
 */
export class BrushStroke {
  private readonly buffer: OffscreenCanvas;
  private readonly bctx: OffscreenCanvasRenderingContext2D;
  private readonly base: OffscreenCanvas;
  private readonly tex: OffscreenCanvas;
  private dirty: Rect | undefined;
  private pendingDirty: Rect | undefined;
  private last: StrokePoint | undefined;
  /** Distance travelled since the last dab. */
  private carry = 0;

  constructor(
    /** Coordinates passed to begin()/to() are in this surface's pixels. */
    private readonly surface: PaintSurface,
    private readonly settings: BrushSettings,
    /** Diameter in image pixels at full pressure. */
    private readonly diameter: number,
    private readonly eraser: boolean,
  ) {
    this.buffer = new OffscreenCanvas(surface.width, surface.height);
    this.bctx = this.buffer.getContext('2d')!;
    this.base = surface.snapshot({ x: 0, y: 0, w: surface.width, h: surface.height });
    this.tex = dabTexture(settings.color, settings.hardness);
  }

  get lastPoint(): StrokePoint | undefined {
    return this.last;
  }

  begin(p: StrokePoint): void {
    this.last = p;
    this.carry = 0;
    this.dab(p);
  }

  /** Places dabs every spacing·diameter along the segment from the previous point. */
  to(p: StrokePoint): void {
    const from = this.last;
    if (!from) return this.begin(p);
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (!dist) return;
    // Positions are distances along this segment; the previous dab lies `carry` before its start.
    let lastPos = -this.carry;
    let t = lastPos + this.step(from.pressure);
    while (t <= dist) {
      const k = t / dist;
      const q = { x: from.x + dx * k, y: from.y + dy * k, pressure: from.pressure + (p.pressure - from.pressure) * k };
      this.dab(q);
      lastPos = t;
      t = lastPos + this.step(q.pressure);
    }
    this.carry = dist - lastPos;
    this.last = p;
  }

  /** Applies buffered dabs to the document (called once per animation frame). */
  render(): void {
    const r = this.pendingDirty;
    if (!r) return;
    this.pendingDirty = undefined;
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(this.base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    ctx.globalAlpha = this.settings.opacity;
    ctx.globalCompositeOperation = this.eraser ? 'destination-out' : 'source-over';
    ctx.drawImage(this.buffer, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    ctx.restore();
    this.surface.touched(r);
  }

  end(): void {
    this.render();
    if (!this.dirty) return;
    const r = this.dirty;
    this.surface.commitRegion(this.eraser ? 'Erase' : 'Brush', r, copyRegion(this.base, r));
  }

  private step(pressure: number): number {
    return Math.max(0.5, this.settings.spacing * this.size(pressure));
  }

  private size(pressure: number): number {
    return Math.max(0.5, this.diameter * (this.settings.pressureSize ? pressure : 1));
  }

  private dab(p: StrokePoint): void {
    const d = this.size(p.pressure);
    this.bctx.globalAlpha = this.settings.flow * (this.settings.pressureOpacity ? p.pressure : 1);
    this.bctx.drawImage(this.tex, p.x - d / 2, p.y - d / 2, d, d);
    const r = clampRect({ x: p.x - d / 2 - 1, y: p.y - d / 2 - 1, w: d + 2, h: d + 2 }, this.surface.width, this.surface.height);
    if (!r) return;
    this.dirty = union(this.dirty, r);
    this.pendingDirty = union(this.pendingDirty, r);
  }
}

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function copyRegion(src: OffscreenCanvas, r: Rect): OffscreenCanvas {
  const c = new OffscreenCanvas(r.w, r.h);
  c.getContext('2d')!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}
