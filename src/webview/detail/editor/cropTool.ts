import { fitAspect, snapDown, type Size } from '../../../shared/buckets';
import type { ImagePoint, ImageViewer, ViewTransform, ViewerTool } from '../imageViewer';
import type { EditDocument, Rect } from './document';

export interface CropOptions {
  /** Width/height ratio, or null for a free crop. */
  aspect: number | null;
  /** Result width and height are rounded down to a multiple of this (1 = off). */
  snap: number;
  /** Target bucket, shown as the training resolution the crop will be resized to. */
  bucket?: Size;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Drag =
  | { kind: 'create'; ax: number; ay: number }
  | { kind: 'move'; ox: number; oy: number; start: Rect }
  | { kind: 'resize'; handle: Handle; start: Rect };

const HANDLE_PX = 8;
const CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

export class CropTool implements ViewerTool {
  rect: Rect | undefined;
  private drag: Drag | undefined;
  private hoverCursor = 'crosshair';

  constructor(
    private readonly doc: () => EditDocument | undefined,
    private readonly viewer: ImageViewer,
    private readonly changed: () => void,
    public opts: CropOptions,
  ) {}

  get cursor(): string {
    return this.hoverCursor;
  }

  reset(): void {
    this.rect = undefined;
    this.drag = undefined;
    this.changed();
  }

  /** Sets the options and, with a fixed aspect, refits the current (or a full-size) rectangle. */
  setOptions(opts: CropOptions): void {
    this.opts = opts;
    const d = this.doc();
    if (!d) return;
    if (opts.aspect) {
      const base = this.rect ?? { x: 0, y: 0, w: d.width, h: d.height };
      const cx = base.x + base.w / 2;
      const cy = base.y + base.h / 2;
      const s = fitAspect(Math.min(base.w, d.width), Math.min(base.h, d.height), opts.aspect);
      if (!this.rect) {
        const full = fitAspect(d.width, d.height, opts.aspect);
        s.w = full.w;
        s.h = full.h;
      }
      this.rect = this.clampMove({ x: cx - s.w / 2, y: cy - s.h / 2, w: s.w, h: s.h }, d);
    }
    this.changed();
  }

  /** The crop that would be applied: whole pixels, size snapped, inside the image. */
  result(): Rect | undefined {
    const d = this.doc();
    const r = this.rect;
    if (!d || !r || r.w < 1 || r.h < 1) return undefined;
    const snap = this.opts.snap;
    const w = Math.min(snapDown(r.w, snap), snapDown(d.width, snap));
    const h = Math.min(snapDown(r.h, snap), snapDown(d.height, snap));
    if (w > d.width || h > d.height) return undefined;
    // Shrink around the centre of the drawn rectangle.
    const x = Math.round(Math.min(Math.max(0, r.x + (r.w - w) / 2), d.width - w));
    const y = Math.round(Math.min(Math.max(0, r.y + (r.h - h) / 2), d.height - h));
    return { x, y, w, h };
  }

  down(_e: PointerEvent, p: ImagePoint): void {
    const d = this.doc();
    if (!d) return;
    const handle = this.hitHandle(p);
    if (handle && this.rect) this.drag = { kind: 'resize', handle, start: { ...this.rect } };
    else if (this.rect && inside(this.rect, p)) this.drag = { kind: 'move', ox: p.x - this.rect.x, oy: p.y - this.rect.y, start: { ...this.rect } };
    else {
      const ax = clamp(p.x, 0, d.width);
      const ay = clamp(p.y, 0, d.height);
      this.drag = { kind: 'create', ax, ay };
      this.rect = { x: ax, y: ay, w: 0, h: 0 };
    }
  }

  move(_e: PointerEvent, points: ImagePoint[]): void {
    const d = this.doc();
    const p = points.at(-1);
    if (!d || !p || !this.drag) return;
    const g = this.drag;
    if (g.kind === 'move') {
      this.rect = this.clampMove({ ...g.start, x: p.x - g.ox, y: p.y - g.oy }, d);
    } else if (g.kind === 'create') {
      this.rect = this.fromAnchor(g.ax, g.ay, p.x, p.y, d);
    } else {
      this.rect = this.resize(g.handle, g.start, p, d);
    }
    this.changed();
  }

  up(): void {
    this.drag = undefined;
    if (this.rect && (this.rect.w < 1 || this.rect.h < 1)) this.rect = undefined;
    this.changed();
  }

  hover(p: ImagePoint | undefined): void {
    const h = p && this.hitHandle(p);
    const next = h ? CURSORS[h] : p && this.rect && inside(this.rect, p) ? 'move' : 'crosshair';
    if (next !== this.hoverCursor) {
      this.hoverCursor = next;
      this.viewer.refreshCursor();
    }
  }

  draw(ctx: CanvasRenderingContext2D, v: ViewTransform): void {
    const d = this.doc();
    const r = this.result();
    if (!d || !this.rect) return;
    const x = v.tx + (r?.x ?? this.rect.x) * v.scale;
    const y = v.ty + (r?.y ?? this.rect.y) * v.scale;
    const w = (r?.w ?? this.rect.w) * v.scale;
    const h = (r?.h ?? this.rect.h) * v.scale;
    const ix = v.tx;
    const iy = v.ty;
    const iw = d.width * v.scale;
    const ih = d.height * v.scale;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(ix, iy, iw, y - iy);
    ctx.fillRect(ix, y + h, iw, iy + ih - y - h);
    ctx.fillRect(ix, y, x - ix, h);
    ctx.fillRect(x + w, y, ix + iw - x - w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const k of [1 / 3, 2 / 3]) {
      ctx.moveTo(x + w * k, y);
      ctx.lineTo(x + w * k, y + h);
      ctx.moveTo(x, y + h * k);
      ctx.lineTo(x + w, y + h * k);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#fff';
    for (const [hx, hy] of this.handlePositions({ x, y, w, h })) ctx.fillRect(hx - 4, hy - 4, 8, 8);
    if (r) {
      const label = this.label(r);
      ctx.font = '12px sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(x + 4, y + 4, tw + 10, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 9, y + 17);
    }
    ctx.restore();
  }

  label(r: Rect): string {
    const b = this.opts.bucket;
    return b ? `${r.w} × ${r.h} → ${b.w} × ${b.h}` : `${r.w} × ${r.h}`;
  }

  private handlePositions(r: Rect): [number, number][] {
    const mx = r.x + r.w / 2;
    const my = r.y + r.h / 2;
    return [
      [r.x, r.y],
      [mx, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, my],
      [r.x + r.w, r.y + r.h],
      [mx, r.y + r.h],
      [r.x, r.y + r.h],
      [r.x, my],
    ];
  }

  private hitHandle(p: ImagePoint): Handle | undefined {
    if (!this.rect) return undefined;
    const tol = HANDLE_PX / this.viewer.zoom;
    const names: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const pos = this.handlePositions(this.rect);
    for (let i = 0; i < names.length; i++) {
      if (Math.abs(p.x - pos[i][0]) <= tol && Math.abs(p.y - pos[i][1]) <= tol) return names[i];
    }
    return undefined;
  }

  /** Rectangle spanned from a fixed anchor to the pointer, honouring the aspect ratio and image bounds. */
  private fromAnchor(ax: number, ay: number, px: number, py: number, d: EditDocument): Rect {
    const sx = px >= ax ? 1 : -1;
    const sy = py >= ay ? 1 : -1;
    let w = Math.min(Math.abs(px - ax), sx > 0 ? d.width - ax : ax);
    let h = Math.min(Math.abs(py - ay), sy > 0 ? d.height - ay : ay);
    const a = this.opts.aspect;
    if (a) {
      if (w / Math.max(h, 1e-9) > a) w = h * a;
      else h = w / a;
    }
    return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  }

  private resize(handle: Handle, s: Rect, p: ImagePoint, d: EditDocument): Rect {
    const a = this.opts.aspect;
    const right = s.x + s.w;
    const bottom = s.y + s.h;
    if (handle.length === 2) {
      const ax = handle.includes('w') ? right : s.x;
      const ay = handle.includes('n') ? bottom : s.y;
      return this.fromAnchor(ax, ay, p.x, p.y, d);
    }
    if (handle === 'n' || handle === 's') {
      const ay = handle === 'n' ? bottom : s.y;
      let h = clamp(Math.abs(p.y - ay), 0, handle === 'n' ? ay : d.height - ay);
      let w = s.w;
      let x = s.x;
      if (a) {
        const cx = s.x + s.w / 2;
        w = Math.min(h * a, 2 * Math.min(cx, d.width - cx));
        h = w / a;
        x = cx - w / 2;
      }
      return { x, y: handle === 'n' ? ay - h : ay, w, h };
    }
    const ax = handle === 'w' ? right : s.x;
    let w = clamp(Math.abs(p.x - ax), 0, handle === 'w' ? ax : d.width - ax);
    let h = s.h;
    let y = s.y;
    if (a) {
      const cy = s.y + s.h / 2;
      h = Math.min(w / a, 2 * Math.min(cy, d.height - cy));
      w = h * a;
      y = cy - h / 2;
    }
    return { x: handle === 'w' ? ax - w : ax, y, w, h };
  }

  private clampMove(r: Rect, d: EditDocument): Rect {
    const w = Math.min(r.w, d.width);
    const h = Math.min(r.h, d.height);
    return { x: clamp(r.x, 0, d.width - w), y: clamp(r.y, 0, d.height - h), w, h };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function inside(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
