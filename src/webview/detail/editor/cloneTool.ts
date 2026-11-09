import { DabSpacer, type DabPoint } from '../../../shared/dabs';
import { dabTexture, type BrushSettings } from './brush';
import { clampRect, type PaintSurface, type Rect } from './document';

/** Clone source in document coordinates, and the source−target offset fixed by the first stroke (aligned mode). */
export class CloneSource {
  point: { x: number; y: number } | undefined;
  offset: { x: number; y: number } | undefined;

  set(x: number, y: number): void {
    this.point = { x, y };
    this.offset = undefined;
  }

  /** Offset for a stroke starting at document point (x, y); the first stroke after set() defines it. */
  offsetFor(x: number, y: number): { x: number; y: number } | undefined {
    if (!this.point) return undefined;
    this.offset ??= { x: this.point.x - x, y: this.point.y - y };
    return this.offset;
  }

  clear(): void {
    this.point = undefined;
    this.offset = undefined;
  }
}

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Clone stamp stroke. Like the brush, dabs (here: soft-masked copies of the source) accumulate
 * in a buffer with `flow` that is composited over the stroke-start pixels with `opacity`.
 * Stroke points are in surface (layer) pixels; `toSource` maps them to source-canvas pixels.
 */
export class CloneStroke {
  private readonly spacer: DabSpacer;
  private readonly buffer: OffscreenCanvas;
  private readonly bctx: OffscreenCanvasRenderingContext2D;
  private readonly base: OffscreenCanvas;
  private readonly mask: OffscreenCanvas;
  private readonly source: OffscreenCanvas;
  private readonly tmp = new OffscreenCanvas(1, 1);
  private dirty: Rect | undefined;
  private pending: Rect | undefined;

  constructor(
    private readonly surface: PaintSurface,
    private readonly settings: BrushSettings,
    private readonly diameter: number,
    /** Source pixels; undefined = the layer itself as it was when the stroke began. */
    source: OffscreenCanvas | undefined,
    private readonly toSource: (x: number, y: number) => { x: number; y: number },
  ) {
    this.spacer = new DabSpacer((pressure) => Math.max(0.5, settings.spacing * this.size(pressure)));
    this.buffer = new OffscreenCanvas(surface.width, surface.height);
    this.bctx = this.buffer.getContext('2d')!;
    this.base = surface.snapshot({ x: 0, y: 0, w: surface.width, h: surface.height });
    this.source = source ?? this.base;
    this.mask = dabTexture('#ffffff', settings.hardness);
  }

  get lastPoint(): DabPoint | undefined {
    return this.spacer.lastPoint;
  }

  begin(p: DabPoint): void {
    for (const q of this.spacer.begin(p)) this.dab(q);
  }

  to(p: DabPoint): void {
    for (const q of this.spacer.to(p)) this.dab(q);
  }

  render(): void {
    const r = this.pending;
    if (!r) return;
    this.pending = undefined;
    const ctx = this.surface.ctx;
    ctx.save();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(this.base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    ctx.globalAlpha = this.settings.opacity;
    ctx.drawImage(this.buffer, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    ctx.restore();
    this.surface.touched(r);
  }

  end(): void {
    this.render();
    const r = this.dirty;
    if (!r) return;
    const before = new OffscreenCanvas(r.w, r.h);
    before.getContext('2d')!.drawImage(this.base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    this.surface.commitRegion('Clone', r, before);
  }

  private size(pressure: number): number {
    return Math.max(1, this.diameter * (this.settings.pressureSize ? pressure : 1));
  }

  private dab(p: DabPoint): void {
    const n = Math.ceil(this.size(p.pressure));
    if (this.tmp.width !== n || this.tmp.height !== n) {
      this.tmp.width = n;
      this.tmp.height = n;
    }
    const s = this.toSource(p.x, p.y);
    const g = this.tmp.getContext('2d')!;
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.source, s.x - n / 2, s.y - n / 2, n, n, 0, 0, n, n);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(this.mask, 0, 0, n, n);
    this.bctx.globalAlpha = this.settings.flow * (this.settings.pressureOpacity ? p.pressure : 1);
    this.bctx.drawImage(this.tmp, p.x - n / 2, p.y - n / 2);
    const r = clampRect({ x: p.x - n / 2 - 1, y: p.y - n / 2 - 1, w: n + 2, h: n + 2 }, this.surface.width, this.surface.height);
    if (!r) return;
    this.dirty = union(this.dirty, r);
    this.pending = union(this.pending, r);
  }
}
