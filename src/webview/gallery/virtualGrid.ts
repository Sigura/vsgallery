import type { ImageEntry } from '../../shared/protocol';

export interface Group {
  /** null = no header row (flat / single folder view). */
  title: string | null;
  entries: ImageEntry[];
}

export interface GridHooks {
  createTile(): HTMLElement;
  bindTile(el: HTMLElement, entry: ImageEntry): void;
  createHeader(): HTMLElement;
  bindHeader(el: HTMLElement, group: Group): void;
  /** Entries in viewport first (top-left to bottom-right), then overscan rows. */
  visibleChanged(inView: ImageEntry[], overscan: ImageEntry[]): void;
}

export interface Anchor {
  id: string;
  offset: number;
}

type Row =
  | { kind: 'header'; top: number; group: Group; key: string }
  | { kind: 'tiles'; top: number; start: number; count: number };

const PAD = 10;
const GAP = 10;
const LABEL_H = 40;
const HEADER_H = 34;

export class VirtualGrid {
  private groups: Group[] = [];
  private items: ImageEntry[] = [];
  private rows: Row[] = [];
  private rowOfItem: Int32Array = new Int32Array(0);
  private indexOfId = new Map<string, number>();
  private cols = 1;
  private tile: number;
  private live = new Map<string, HTMLElement>();
  private liveHeaders = new Map<string, HTMLElement>();
  private freeTiles: HTMLElement[] = [];
  private freeHeaders: HTMLElement[] = [];
  private frame = 0;
  private rebindAll = false;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly spacer: HTMLElement,
    private readonly hooks: GridHooks,
    tileSize: number,
  ) {
    this.tile = tileSize;
    scroller.style.setProperty('--tile', `${tileSize}px`);
    scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => {
      const anchor = this.anchor();
      if (this.layout()) this.restore(anchor);
      this.schedule();
    }).observe(scroller);
  }

  get tileSize(): number {
    return this.tile;
  }

  get rowHeight(): number {
    return this.tile + LABEL_H + GAP;
  }

  setData(groups: Group[], anchor: Anchor | undefined = this.anchor()): void {
    this.groups = groups;
    this.items = groups.flatMap((g) => g.entries);
    this.indexOfId = new Map(this.items.map((e, i) => [e.id, i]));
    this.rebindAll = true;
    this.layout(true);
    this.restore(anchor);
    this.schedule();
  }

  setTileSize(size: number): void {
    if (size === this.tile) return;
    const anchor = this.anchor();
    this.tile = size;
    this.scroller.style.setProperty('--tile', `${size}px`);
    this.rebindAll = true;
    this.layout(true);
    this.restore(anchor);
    this.schedule();
  }

  get order(): readonly ImageEntry[] {
    return this.items;
  }

  indexOf(id: string): number | undefined {
    return this.indexOfId.get(id);
  }

  /** Re-binds every rendered tile (e.g. after a selection change). */
  refreshLive(): void {
    for (const [id, el] of this.live) {
      const e = this.entry(id);
      if (e) this.hooks.bindTile(el, e);
    }
  }

  /** Ids of tiles intersecting a rectangle in content coordinates. */
  idsInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const out: string[] = [];
    const tileH = this.tile + LABEL_H;
    for (let r = this.firstRowAt(y0); r < this.rows.length && this.rows[r].top <= y1; r++) {
      const row = this.rows[r];
      if (row.kind !== 'tiles' || row.top + tileH < y0) continue;
      for (let c = 0; c < row.count; c++) {
        const tx = PAD + c * (this.tile + GAP);
        if (tx + this.tile >= x0 && tx <= x1) out.push(this.items[row.start + c].id);
      }
    }
    return out;
  }

  /** Keyboard navigation target from `id` (or the first item when id is unknown). */
  neighbor(id: string | undefined, key: 'left' | 'right' | 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end'): string | undefined {
    const n = this.items.length;
    if (!n) return undefined;
    const i = id === undefined ? undefined : this.indexOfId.get(id);
    if (i === undefined || key === 'home') return this.items[0].id;
    if (key === 'end') return this.items[n - 1].id;
    if (key === 'left') return this.items[Math.max(0, i - 1)].id;
    if (key === 'right') return this.items[Math.min(n - 1, i + 1)].id;
    const dir = key === 'up' || key === 'pageup' ? -1 : 1;
    let steps = key === 'up' || key === 'down' ? 1 : Math.max(1, Math.floor(this.scroller.clientHeight / this.rowHeight));
    const start = this.rowOfItem[i];
    const from = this.rows[start];
    if (from.kind !== 'tiles') return undefined;
    const col = i - from.start;
    let target = start;
    for (let r = start + dir; r >= 0 && r < this.rows.length && steps > 0; r += dir) {
      if (this.rows[r].kind === 'tiles') {
        target = r;
        steps--;
      }
    }
    const row = this.rows[target];
    return row.kind === 'tiles' ? this.items[row.start + Math.min(col, row.count - 1)].id : undefined;
  }

  ensureVisible(id: string): void {
    const i = this.indexOfId.get(id);
    if (i === undefined) return;
    const row = this.rows[this.rowOfItem[i]];
    const top = this.scroller.scrollTop;
    const bottom = top + this.scroller.clientHeight;
    if (row.top < top) this.scroller.scrollTop = row.top - PAD;
    else if (row.top + this.rowHeight > bottom) this.scroller.scrollTop = row.top + this.rowHeight - this.scroller.clientHeight;
  }

  entry(id: string): ImageEntry | undefined {
    const i = this.indexOfId.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  refresh(id: string): void {
    const el = this.live.get(id);
    const e = this.entry(id);
    if (el && e) this.hooks.bindTile(el, e);
  }

  /** First tile row intersecting the top of the viewport. */
  anchor(): Anchor | undefined {
    const top = this.scroller.scrollTop;
    for (let r = this.firstRowAt(top); r < this.rows.length; r++) {
      const row = this.rows[r];
      if (row.kind === 'tiles') return { id: this.items[row.start].id, offset: row.top - top };
    }
    return undefined;
  }

  restore(anchor: Anchor | undefined): void {
    if (!anchor) return;
    const i = this.indexOfId.get(anchor.id);
    if (i === undefined) return;
    this.scroller.scrollTop = this.rows[this.rowOfItem[i]].top - anchor.offset;
  }

  scrollToId(id: string): boolean {
    const i = this.indexOfId.get(id);
    if (i === undefined) return false;
    const row = this.rows[this.rowOfItem[i]];
    this.scroller.scrollTop = row.top - (this.scroller.clientHeight - this.rowHeight) / 2;
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  /** Returns true if the column count (and therefore row geometry) changed. */
  private layout(force = false): boolean {
    const width = this.scroller.clientWidth;
    const cols = Math.max(1, Math.floor((width - 2 * PAD + GAP) / (this.tile + GAP)));
    if (!force && cols === this.cols) return false;
    this.cols = cols;
    const rows: Row[] = [];
    const rowOfItem = new Int32Array(this.items.length);
    const rowH = this.rowHeight;
    let top = PAD;
    let start = 0;
    for (const g of this.groups) {
      if (g.title !== null) {
        rows.push({ kind: 'header', top, group: g, key: g.title });
        top += HEADER_H;
      }
      for (let i = 0; i < g.entries.length; i += cols) {
        const count = Math.min(cols, g.entries.length - i);
        rowOfItem.fill(rows.length, start + i, start + i + count);
        rows.push({ kind: 'tiles', top, start: start + i, count });
        top += rowH;
      }
      start += g.entries.length;
    }
    this.rows = rows;
    this.rowOfItem = rowOfItem;
    this.spacer.style.height = `${top + PAD}px`;
    return true;
  }

  private rowBottom(r: number): number {
    const row = this.rows[r];
    return row.top + (row.kind === 'header' ? HEADER_H : this.rowHeight);
  }

  private firstRowAt(y: number): number {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rowBottom(mid) <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private render(): void {
    this.frame = 0;
    const viewTop = this.scroller.scrollTop;
    const viewBottom = viewTop + this.scroller.clientHeight;
    const over = this.rowHeight * 2;
    const nextLive = new Map<string, HTMLElement>();
    const nextHeaders = new Map<string, HTMLElement>();
    const inView: ImageEntry[] = [];
    const overscan: ImageEntry[] = [];
    const rebind = this.rebindAll;
    this.rebindAll = false;

    for (let r = this.firstRowAt(viewTop - over); r < this.rows.length; r++) {
      const row = this.rows[r];
      if (row.top >= viewBottom + over) break;
      if (row.kind === 'header') {
        let el = this.liveHeaders.get(row.key);
        if (el) this.liveHeaders.delete(row.key);
        else el = this.freeHeaders.pop() ?? this.attach(this.hooks.createHeader());
        el.style.display = '';
        el.style.transform = `translate(${PAD}px, ${row.top}px)`;
        this.hooks.bindHeader(el, row.group);
        nextHeaders.set(row.key, el);
        continue;
      }
      const visible = row.top < viewBottom && this.rowBottom(r) > viewTop;
      for (let c = 0; c < row.count; c++) {
        const entry = this.items[row.start + c];
        let el = this.live.get(entry.id);
        const reused = el !== undefined;
        if (el) this.live.delete(entry.id);
        else el = this.freeTiles.pop() ?? this.attach(this.hooks.createTile());
        el.style.display = '';
        el.style.transform = `translate(${PAD + c * (this.tile + GAP)}px, ${row.top}px)`;
        if (!reused || rebind) this.hooks.bindTile(el, entry);
        nextLive.set(entry.id, el);
        (visible ? inView : overscan).push(entry);
      }
    }

    for (const el of this.live.values()) this.release(el, this.freeTiles);
    for (const el of this.liveHeaders.values()) this.release(el, this.freeHeaders);
    this.live = nextLive;
    this.liveHeaders = nextHeaders;
    this.hooks.visibleChanged(inView, overscan);
  }

  private attach(el: HTMLElement): HTMLElement {
    this.scroller.appendChild(el);
    return el;
  }

  private release(el: HTMLElement, pool: HTMLElement[]): void {
    el.style.display = 'none';
    pool.push(el);
  }
}
