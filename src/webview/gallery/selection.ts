import type { VirtualGrid } from './virtualGrid';

const DRAG_THRESHOLD = 5;
const AUTOSCROLL_EDGE = 40;
const AUTOSCROLL_MAX = 24;
const DOUBLE_CLICK_MS = 400;

type NavKey = Parameters<VirtualGrid['neighbor']>[1];
const NAV_KEYS: Record<string, NavKey> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Home: 'home',
  End: 'end',
};

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  tileId: string | undefined;
  additive: boolean;
  base: Set<string>;
  banding: boolean;
  frame: number;
}

/** Click / Ctrl / Shift selection, rubber band with autoscroll, and keyboard navigation over the grid. */
export class SelectionController {
  readonly selected = new Set<string>();
  private anchor: string | undefined;
  focus: string | undefined;
  private drag: Drag | undefined;
  // Pointer capture retargets click/dblclick to the scroller, so double-clicks are detected here.
  private lastClick: { id: string; time: number } | undefined;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly band: HTMLElement,
    private readonly grid: () => VirtualGrid | undefined,
    private readonly changed: () => void,
    private readonly onDelete: () => void,
    private readonly onOpen: (id: string) => void,
  ) {
    scroller.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    scroller.addEventListener('pointermove', (e) => this.onPointerMove(e));
    scroller.addEventListener('pointerup', (e) => this.onPointerUp(e));
    scroller.addEventListener('pointercancel', () => this.endDrag());
    scroller.addEventListener('keydown', (e) => this.onKeyDown(e));
    scroller.addEventListener('contextmenu', (e) => this.onContextMenu(e));
  }

  /** Drops ids that no longer exist (deleted / filtered out). */
  prune(exists: (id: string) => boolean): void {
    let dirty = false;
    for (const id of [...this.selected]) {
      if (!exists(id)) {
        this.selected.delete(id);
        dirty = true;
      }
    }
    if (this.focus && !exists(this.focus)) this.focus = undefined;
    if (this.anchor && !exists(this.anchor)) this.anchor = undefined;
    if (dirty) this.changed();
  }

  selectOnly(id: string): void {
    this.anchor = this.focus = id;
    this.replace([id]);
  }

  selectAll(): void {
    const g = this.grid();
    if (!g) return;
    this.replace(g.order.map((e) => e.id));
  }

  clear(): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.changed();
  }

  private replace(ids: Iterable<string>): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.changed();
  }

  private range(a: string, b: string): string[] {
    const g = this.grid();
    const i = g?.indexOf(a);
    const j = g?.indexOf(b);
    if (!g || i === undefined || j === undefined) return [b];
    const [lo, hi] = i < j ? [i, j] : [j, i];
    return g.order.slice(lo, hi + 1).map((e) => e.id);
  }

  private click(id: string | undefined, ctrl: boolean, shift: boolean): void {
    if (!id) {
      if (!ctrl && !shift) this.clear();
      return;
    }
    if (shift && this.anchor) {
      const ids = this.range(this.anchor, id);
      if (ctrl) for (const x of ids) this.selected.add(x);
      else this.replace(ids);
    } else if (ctrl) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.anchor = id;
    } else {
      this.replace([id]);
      this.anchor = id;
    }
    this.focus = id;
    this.changed();
  }

  private toContent(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.scroller.getBoundingClientRect();
    return { x: clientX - r.left + this.scroller.scrollLeft, y: clientY - r.top + this.scroller.scrollTop };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // Clicks on the scrollbar.
    if (e.clientX - this.scroller.getBoundingClientRect().left >= this.scroller.clientWidth) return;
    this.scroller.focus({ preventScroll: true });
    const p = this.toContent(e.clientX, e.clientY);
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    const additive = e.ctrlKey || e.metaKey;
    this.drag = {
      pointerId: e.pointerId,
      startX: p.x,
      startY: p.y,
      clientX: e.clientX,
      clientY: e.clientY,
      tileId: tile?.dataset.id,
      additive,
      base: additive ? new Set(this.selected) : new Set(),
      banding: false,
      frame: 0,
    };
    this.scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    d.clientX = e.clientX;
    d.clientY = e.clientY;
    if (!d.banding) {
      const p = this.toContent(e.clientX, e.clientY);
      if (Math.hypot(p.x - d.startX, p.y - d.startY) < DRAG_THRESHOLD) return;
      d.banding = true;
      this.band.hidden = false;
      d.frame = requestAnimationFrame(() => this.autoscroll());
    }
    this.updateBand();
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.endDrag();
    if (d.banding) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const now = performance.now();
    const plain = !ctrl && !e.shiftKey;
    if (plain && d.tileId && this.lastClick?.id === d.tileId && now - this.lastClick.time < DOUBLE_CLICK_MS) {
      this.lastClick = undefined;
      this.onOpen(d.tileId);
      return;
    }
    this.lastClick = plain && d.tileId ? { id: d.tileId, time: now } : undefined;
    this.click(d.tileId, ctrl, e.shiftKey);
  }

  private endDrag(): void {
    const d = this.drag;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    if (this.scroller.hasPointerCapture(d.pointerId)) this.scroller.releasePointerCapture(d.pointerId);
    this.band.hidden = true;
    this.drag = undefined;
  }

  private updateBand(): void {
    const d = this.drag;
    const g = this.grid();
    if (!d || !g) return;
    const p = this.toContent(d.clientX, d.clientY);
    const x0 = Math.min(d.startX, p.x);
    const y0 = Math.min(d.startY, p.y);
    const x1 = Math.max(d.startX, p.x);
    const y1 = Math.max(d.startY, p.y);
    this.band.style.transform = `translate(${x0}px, ${y0}px)`;
    this.band.style.width = `${x1 - x0}px`;
    this.band.style.height = `${y1 - y0}px`;
    const hits = g.idsInRect(x0, y0, x1, y1);
    const next = new Set(d.base);
    for (const id of hits) next.add(id);
    if (next.size !== this.selected.size || hits.some((id) => !this.selected.has(id))) this.replace(next);
  }

  private autoscroll(): void {
    const d = this.drag;
    if (!d) return;
    const r = this.scroller.getBoundingClientRect();
    let dy = 0;
    if (d.clientY < r.top + AUTOSCROLL_EDGE) dy = -Math.min(AUTOSCROLL_MAX, r.top + AUTOSCROLL_EDGE - d.clientY);
    else if (d.clientY > r.bottom - AUTOSCROLL_EDGE) dy = Math.min(AUTOSCROLL_MAX, d.clientY - (r.bottom - AUTOSCROLL_EDGE));
    if (dy) {
      this.scroller.scrollTop += dy;
      this.updateBand();
    }
    d.frame = requestAnimationFrame(() => this.autoscroll());
  }

  private onContextMenu(e: MouseEvent): void {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.tile')?.dataset.id;
    if (id && !this.selected.has(id)) this.click(id, false, false);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const g = this.grid();
    if (!g) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const nav = NAV_KEYS[e.key];
    if (nav) {
      const next = g.neighbor(this.focus, nav);
      if (!next) return;
      e.preventDefault();
      if (e.shiftKey) {
        this.anchor ??= this.focus ?? next;
        this.replace(this.range(this.anchor, next));
      } else if (!ctrl) {
        this.replace([next]);
        this.anchor = next;
      }
      this.focus = next;
      g.ensureVisible(next);
      this.changed();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selectAll();
    } else if (ctrl && e.key === ' ' && this.focus) {
      e.preventDefault();
      this.click(this.focus, true, false);
    } else if (e.key === 'Enter' && this.focus) {
      e.preventDefault();
      this.onOpen(this.focus);
    } else if (e.key === 'Escape') {
      this.clear();
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      e.preventDefault();
      this.onDelete();
    }
  }
}
