import { resizeByCorner, type Corner, type LRect } from '../../../shared/layerMath';
import type { ImagePoint, ViewTransform, ViewerTool } from '../imageViewer';
import type { EditDocument, Layer } from './document';

const HANDLE_PX = 8;
const CORNERS: Corner[] = ['nw', 'ne', 'se', 'sw'];
const CURSOR: Record<Corner, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

type Drag = { layer: Layer; start: LRect; from: ImagePoint; corner?: Corner };

const rectOf = (l: Layer): LRect => ({ x: l.x, y: l.y, w: l.w, h: l.h });

function cornerPoint(r: LRect, c: Corner): { x: number; y: number } {
  return { x: c === 'nw' || c === 'sw' ? r.x : r.x + r.w, y: c === 'nw' || c === 'ne' ? r.y : r.y + r.h };
}

/**
 * Moves the active layer by dragging anywhere, or scales it with the corner handles (Shift keeps
 * the aspect ratio). Scaling stays pending until the editor rasterizes it (when another tool is used).
 */
export class MoveTool implements ViewerTool {
  cursor = 'move';
  private drag: Drag | undefined;

  constructor(
    private readonly getDoc: () => EditDocument | undefined,
    private readonly view: () => ViewTransform,
    private readonly setCursor: (c: string) => void,
  ) {}

  /** Moves the active layer by whole pixels (arrow keys). */
  nudge(dx: number, dy: number): void {
    const d = this.getDoc();
    if (!d) return;
    const l = d.active;
    d.setPlacement(l, rectOf(l), { ...rectOf(l), x: l.x + dx, y: l.y + dy });
  }

  down(_e: PointerEvent, p: ImagePoint): void {
    const d = this.getDoc();
    if (!d) return;
    const l = d.active;
    this.drag = { layer: l, start: rectOf(l), from: p, corner: this.cornerAt(l, p) };
  }

  move(e: PointerEvent, pts: ImagePoint[]): void {
    const d = this.getDoc();
    const g = this.drag;
    const p = pts.at(-1)!;
    if (!d || !g) return;
    if (g.corner) {
      d.previewPlacement(g.layer, resizeByCorner(g.start, g.corner, p.x, p.y, e.shiftKey));
    } else {
      const dx = Math.round(p.x - g.from.x);
      const dy = Math.round(p.y - g.from.y);
      d.previewPlacement(g.layer, { ...g.start, x: g.start.x + dx, y: g.start.y + dy });
    }
  }

  up(): void {
    const d = this.getDoc();
    const g = this.drag;
    this.drag = undefined;
    if (d && g) d.setPlacement(g.layer, g.start, rectOf(g.layer), g.corner ? 'Scale layer' : 'Move layer');
  }

  hover(p: ImagePoint | undefined): void {
    const d = this.getDoc();
    const c = d && p ? this.cornerAt(d.active, p) : undefined;
    this.setCursor(c ? CURSOR[c] : 'move');
  }

  /** Outline and corner handles of the active layer. */
  draw(ctx: CanvasRenderingContext2D, v: ViewTransform): void {
    const d = this.getDoc();
    if (!d) return;
    const r = rectOf(d.active);
    const x = v.tx + r.x * v.scale;
    const y = v.ty + r.y * v.scale;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, r.w * v.scale, r.h * v.scale);
    ctx.lineDashOffset = 4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, r.w * v.scale, r.h * v.scale);
    ctx.setLineDash([]);
    for (const c of CORNERS) {
      const p = cornerPoint(r, c);
      const sx = Math.round(v.tx + p.x * v.scale) - HANDLE_PX / 2 + 0.5;
      const sy = Math.round(v.ty + p.y * v.scale) - HANDLE_PX / 2 + 0.5;
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx, sy, HANDLE_PX, HANDLE_PX);
      ctx.strokeStyle = '#000';
      ctx.strokeRect(sx, sy, HANDLE_PX, HANDLE_PX);
    }
    ctx.restore();
  }

  private cornerAt(l: Layer, p: ImagePoint): Corner | undefined {
    const v = this.view();
    const tol = HANDLE_PX / v.scale;
    return CORNERS.find((c) => {
      const q = cornerPoint(rectOf(l), c);
      return Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol;
    });
  }
}
