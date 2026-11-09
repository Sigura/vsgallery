import { DabSpacer, type DabPoint } from '../../../shared/dabs';
import { dabTexture, type BrushSettings } from './brush';
import { clampRect, type PaintSurface, type Rect } from './document';

export interface WetSettings {
  /** How much of the paint under the previous dab is dragged along (0–1). */
  wetness: number;
  /** How much brush colour is mixed in (0 = pure smudge, 1 = mostly brush colour). */
  mix: number;
}

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Wet paint: every dab first carries the pixels under the previous dab to its own position
 * (smudging), masked by the soft dab shape, then mixes in the brush colour. It paints directly
 * on the surface, since each dab must see the result of the previous ones.
 */
export class WetStroke {
  private readonly spacer: DabSpacer;
  private readonly base: OffscreenCanvas;
  private readonly mask: OffscreenCanvas;
  private readonly tex: OffscreenCanvas;
  private readonly tmp = new OffscreenCanvas(1, 1);
  private prev: DabPoint | undefined;
  private dirty: Rect | undefined;
  private pending: Rect | undefined;

  constructor(
    private readonly surface: PaintSurface,
    private readonly settings: BrushSettings,
    private readonly wet: WetSettings,
    private readonly diameter: number,
  ) {
    this.spacer = new DabSpacer((pressure) => Math.max(0.5, settings.spacing * this.size(pressure)));
    this.base = surface.snapshot({ x: 0, y: 0, w: surface.width, h: surface.height });
    this.tex = dabTexture(settings.color, settings.hardness);
    this.mask = dabTexture('#ffffff', settings.hardness);
  }

  get lastPoint(): DabPoint | undefined {
    return this.spacer.lastPoint;
  }

  begin(p: DabPoint): void {
    this.prev = undefined;
    for (const q of this.spacer.begin(p)) this.dab(q);
  }

  to(p: DabPoint): void {
    for (const q of this.spacer.to(p)) this.dab(q);
  }

  render(): void {
    const r = this.pending;
    this.pending = undefined;
    if (r) this.surface.touched(r);
  }

  end(): void {
    this.render();
    const r = this.dirty;
    if (!r) return;
    const before = new OffscreenCanvas(r.w, r.h);
    before.getContext('2d')!.drawImage(this.base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    this.surface.commitRegion('Wet paint', r, before);
  }

  private size(pressure: number): number {
    return Math.max(1, this.diameter * (this.settings.pressureSize ? pressure : 1));
  }

  private dab(p: DabPoint): void {
    const d = this.size(p.pressure);
    const ctx = this.surface.ctx;
    const strength = this.settings.opacity * (this.settings.pressureOpacity ? p.pressure : 1);
    const from = this.prev;
    this.prev = p;
    if (from && this.wet.wetness > 0) {
      // Copy the soft-masked patch under the previous dab, then lay it down here.
      const n = Math.ceil(d);
      if (this.tmp.width !== n || this.tmp.height !== n) {
        this.tmp.width = n;
        this.tmp.height = n;
      }
      const g = this.tmp.getContext('2d')!;
      g.globalCompositeOperation = 'copy';
      g.drawImage(this.surface.ctx.canvas as OffscreenCanvas, from.x - n / 2, from.y - n / 2, n, n, 0, 0, n, n);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(this.mask, 0, 0, n, n);
      ctx.save();
      ctx.globalAlpha = this.wet.wetness * strength;
      ctx.drawImage(this.tmp, p.x - n / 2, p.y - n / 2);
      ctx.restore();
    }
    // The first dab of a stroke has nothing to smudge yet: it deposits colour per `mix` only.
    const colour = this.wet.mix * this.settings.flow * strength;
    if (colour > 0) {
      ctx.save();
      ctx.globalAlpha = colour;
      ctx.drawImage(this.tex, p.x - d / 2, p.y - d / 2, d, d);
      ctx.restore();
    }
    const r = clampRect({ x: p.x - d / 2 - 1, y: p.y - d / 2 - 1, w: d + 2, h: d + 2 }, this.surface.width, this.surface.height);
    if (!r) return;
    this.dirty = union(this.dirty, r);
    this.pending = union(this.pending, r);
  }
}
