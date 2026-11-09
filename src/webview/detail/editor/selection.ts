import { combineMasks, floodFill, invertMask, maskBounds, maskOutline, polygonMask, rectMask, type MaskOp, type MaskRect } from '../../../shared/mask';
import { intersectRect } from '../../../shared/layerMath';
import type { ImagePoint, ViewTransform, ViewerTool } from '../imageViewer';
import type { EditDocument } from './document';

export type SelectToolName = 'selRect' | 'lasso' | 'wand';

/** Pixel selection in document coordinates, shown with marching ants. */
export class Selection {
  private mask: Uint8Array | undefined;
  private w = 0;
  private h = 0;
  private outline: Path2D | undefined;
  private box: MaskRect | undefined;

  get active(): boolean {
    return this.mask !== undefined;
  }

  get bounds(): MaskRect | undefined {
    return this.box;
  }

  has(x: number, y: number): boolean {
    return !!this.mask && this.mask[y * this.w + x] === 1;
  }

  clear(): void {
    this.mask = undefined;
    this.outline = undefined;
    this.box = undefined;
  }

  /** Drops the selection when the document size no longer matches it. */
  fit(w: number, h: number): void {
    if (this.mask && (w !== this.w || h !== this.h)) this.clear();
  }

  apply(shape: Uint8Array, w: number, h: number, op: MaskOp): void {
    this.fit(w, h);
    this.w = w;
    this.h = h;
    this.set(combineMasks(this.mask, shape, op));
  }

  all(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.set(new Uint8Array(w * h).fill(1));
  }

  invert(w: number, h: number): void {
    this.fit(w, h);
    this.w = w;
    this.h = h;
    this.set(this.mask ? invertMask(this.mask) : new Uint8Array(w * h).fill(1));
  }

  private set(mask: Uint8Array): void {
    this.box = maskBounds(mask, this.w, this.h);
    this.mask = this.box ? mask : undefined;
    this.outline = undefined;
    if (!this.mask) return;
    const segs = maskOutline(mask, this.w, this.h);
    const path = new Path2D();
    for (let i = 0; i < segs.length; i += 4) {
      path.moveTo(segs[i], segs[i + 1]);
      path.lineTo(segs[i + 2], segs[i + 3]);
    }
    this.outline = path;
  }

  /** Marching ants; `phase` advances to animate them. */
  draw(ctx: CanvasRenderingContext2D, v: ViewTransform, phase: number): void {
    if (!this.outline) return;
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.scale, v.scale);
    const px = 1 / v.scale;
    ctx.lineWidth = px;
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.lineDashOffset = -phase * px;
    ctx.strokeStyle = '#000';
    ctx.stroke(this.outline);
    ctx.lineDashOffset = (4 - phase) * px;
    ctx.strokeStyle = '#fff';
    ctx.stroke(this.outline);
    ctx.restore();
  }
}

export interface SelectHost {
  doc(): EditDocument | undefined;
  selection: Selection;
  tolerance(): number;
  /** View scale: a drag under 2 screen pixels is a click, not a tiny rectangle. */
  zoom(): number;
  /** Selection changed (refresh buttons and view). */
  changed(): void;
  requestDraw(): void;
}

export type PreviewTool = ViewerTool & { drawPreview(ctx: CanvasRenderingContext2D, v: ViewTransform): void };

const opOf = (e: PointerEvent): MaskOp => (e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');

/** Rectangle, freehand (lasso) and contiguous (magic wand) selection; Shift adds, Alt subtracts. */
export function selectionTools(host: SelectHost): Record<SelectToolName, PreviewTool> {
  let op: MaskOp = 'replace';
  let start: ImagePoint | undefined;
  let current: ImagePoint | undefined;
  let lasso: ImagePoint[] = [];

  const finish = (shape: Uint8Array | undefined) => {
    const d = host.doc();
    if (!d) return;
    if (shape) host.selection.apply(shape, d.width, d.height, op);
    else if (op === 'replace') host.selection.clear();
    host.changed();
  };

  const toScreen = (v: ViewTransform, p: { x: number; y: number }) => ({ x: v.tx + p.x * v.scale, y: v.ty + p.y * v.scale });
  const dashed = (ctx: CanvasRenderingContext2D, path: () => void) => {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    path();
    ctx.stroke();
    ctx.lineDashOffset = 4;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  };

  const selRect: PreviewTool = {
    cursor: 'crosshair',
    down: (e, p) => {
      op = opOf(e);
      start = current = p;
    },
    move: (_e, pts) => {
      current = pts.at(-1);
      host.requestDraw();
    },
    up: (_e, p) => {
      const d = host.doc();
      const a = start;
      start = current = undefined;
      if (!d || !a) return;
      const r = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
      finish(r.w * host.zoom() >= 2 && r.h * host.zoom() >= 2 ? rectMask(d.width, d.height, r) : undefined);
    },
    drawPreview: (ctx, v) => {
      if (!start || !current) return;
      const a = toScreen(v, start);
      const b = toScreen(v, current);
      dashed(ctx, () => ctx.rect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y)));
    },
  };

  const lassoTool: PreviewTool = {
    cursor: 'crosshair',
    down: (e, p) => {
      op = opOf(e);
      lasso = [p];
    },
    move: (_e, pts) => {
      lasso.push(...pts);
      host.requestDraw();
    },
    up: () => {
      const d = host.doc();
      const pts = lasso;
      lasso = [];
      if (!d) return;
      finish(pts.length >= 3 ? polygonMask(d.width, d.height, pts) : undefined);
    },
    drawPreview: (ctx, v) => {
      if (lasso.length < 2) return;
      dashed(ctx, () => {
        lasso.forEach((p, i) => {
          const s = toScreen(v, p);
          if (i) ctx.lineTo(s.x, s.y);
          else ctx.moveTo(s.x, s.y);
        });
      });
    },
  };

  const wand: PreviewTool = {
    cursor: 'crosshair',
    down: (e, p) => {
      op = opOf(e);
      const d = host.doc();
      if (!d) return;
      const px = d.layerPixels(d.active);
      finish(floodFill(px.data, d.width, d.height, p.x, p.y, host.tolerance()));
    },
    move: () => undefined,
    up: () => undefined,
    drawPreview: () => undefined,
  };

  return { selRect, lasso: lassoTool, wand };
}

/** Makes the selected pixels of the active layer transparent. Returns false when nothing changed. */
export function clearSelected(doc: EditDocument, sel: Selection): boolean {
  const b = sel.bounds;
  if (!b) return false;
  doc.rasterizeAll();
  const l = doc.active;
  const r = intersectRect(b, { x: l.x, y: l.y, w: l.w, h: l.h });
  if (!r) return false;
  const local = { x: r.x - l.x, y: r.y - l.y, w: r.w, h: r.h };
  const surface = doc.surface(l);
  const before = surface.snapshot(local);
  const img = surface.ctx.getImageData(local.x, local.y, local.w, local.h);
  const d = img.data;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (sel.has(r.x + x, r.y + y)) d.fill(0, (y * r.w + x) * 4, (y * r.w + x) * 4 + 4);
    }
  }
  surface.ctx.putImageData(img, local.x, local.y);
  surface.commitRegion('Clear selection', local, before);
  return true;
}
