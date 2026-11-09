import { encodeBmp24 } from '../../../shared/bmp';
import { flipRect, intersectRect, rotateRect, unionRect, type LRect } from '../../../shared/layerMath';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface HistoryEntry {
  id: number;
  label: string;
  bytes: number;
  undo(): void;
  redo(): void;
}

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'bmp';

export function formatOf(name: string): ImageFormat {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'webp' || ext === 'bmp') return ext;
  return 'png';
}

/** JPEG and BMP have no alpha: transparent pixels are composited over white. */
export async function encodeCanvas(canvas: OffscreenCanvas, format: ImageFormat, quality: number): Promise<Uint8Array> {
  const { width, height } = canvas;
  if (format === 'bmp') {
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    return encodeBmp24(width, height, data);
  }
  let src = canvas;
  if (format === 'jpeg') {
    src = new OffscreenCanvas(width, height);
    const g = src.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, width, height);
    g.drawImage(canvas, 0, 0);
  }
  const blob = await src.convertToBlob({ type: `image/${format}`, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

function copyCanvas(src: CanvasImageSource, w: number, h: number, sx = 0, sy = 0): OffscreenCanvas {
  const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  c.getContext('2d')!.drawImage(src, sx, sy, w, h, 0, 0, w, h);
  return c;
}

/** Clamps a rect to the image and rounds it outwards to whole pixels. */
export function clampRect(r: Rect, width: number, height: number): Rect | undefined {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

export interface Layer {
  readonly id: number;
  name: string;
  canvas: OffscreenCanvas;
  /** Placement in document coordinates; may extend beyond the document. */
  x: number;
  y: number;
  /** Displayed size: differs from the canvas size while a scale is pending (see rasterizeAll). */
  w: number;
  h: number;
  visible: boolean;
}

/** Pixels a brush or selection edit works on, in the layer's own canvas coordinates. */
export interface PaintSurface {
  readonly width: number;
  readonly height: number;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  snapshot(r: Rect): OffscreenCanvas;
  /** Records an edit of `rect` whose previous pixels are in `before` (same size as rect). */
  commitRegion(label: string, rect: Rect, before: OffscreenCanvas): void;
  /** Pixels in `rect` changed without a history entry yet (live stroke): refresh the view. */
  touched(rect: Rect): void;
}

interface LayerState {
  layer: Layer;
  canvas: OffscreenCanvas;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

interface DocState {
  width: number;
  height: number;
  active: number;
  layers: LayerState[];
}

const placement = (l: Layer): LRect => ({ x: l.x, y: l.y, w: l.w, h: l.h });

/**
 * Layers being edited plus an undo history. Pixel edits store before/after copies of the touched
 * rectangle only; structural operations (crop, rotate, layer add/remove/move…) store references to
 * the canvases before and after, which they never modify in place. The oldest history is dropped
 * once its copies exceed `memoryLimitBytes`.
 */
export class EditDocument {
  width: number;
  height: number;
  layers: Layer[];
  activeIndex = 0;
  readonly original: OffscreenCanvas;
  /** Flattened view of all layers; undefined while a single plain layer can be shown directly. */
  private composite: OffscreenCanvas | undefined;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private nextId = 1;
  private nextLayerId = 1;
  private savedId = 0;
  private bytes = 0;

  constructor(
    source: CanvasImageSource & { width: number; height: number },
    private readonly memoryLimitBytes: number,
    private readonly changed: (sizeChanged: boolean) => void,
  ) {
    this.width = source.width;
    this.height = source.height;
    this.original = copyCanvas(source, source.width, source.height);
    const canvas = copyCanvas(source, source.width, source.height);
    this.layers = [this.makeLayer('Background', canvas, { x: 0, y: 0, w: this.width, h: this.height })];
  }

  /** What the viewer shows: the flattened visible layers, clipped to the document. */
  get canvas(): OffscreenCanvas {
    return this.composite ?? this.layers[0].canvas;
  }

  get active(): Layer {
    return this.layers[this.activeIndex];
  }

  get dirty(): boolean {
    return (this.undoStack.at(-1)?.id ?? 0) !== this.savedId;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Identifies the current history state, e.g. the state an in-flight save was encoded from. */
  historyMark(): number {
    return this.undoStack.at(-1)?.id ?? 0;
  }

  markSaved(mark: number): void {
    this.savedId = mark;
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    e.undo();
    this.redoStack.push(e);
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    e.redo();
    this.undoStack.push(e);
  }

  setActive(index: number): void {
    if (index < 0 || index >= this.layers.length || index === this.activeIndex) return;
    this.activeIndex = index;
    this.changed(false);
  }

  /** Document point → canvas pixel of `layer` (accounts for a pending scale). */
  toLayer(layer: Layer, x: number, y: number): { x: number; y: number } {
    return { x: ((x - layer.x) * layer.canvas.width) / layer.w, y: ((y - layer.y) * layer.canvas.height) / layer.h };
  }

  surface(layer: Layer = this.active): PaintSurface {
    const doc = this;
    return {
      get width() {
        return layer.canvas.width;
      },
      get height() {
        return layer.canvas.height;
      },
      get ctx() {
        return layer.canvas.getContext('2d')!;
      },
      snapshot: (r) => copyCanvas(layer.canvas, r.w, r.h, r.x, r.y),
      commitRegion: (label, rect, before) => doc.commitRegion(layer, label, rect, before),
      touched: (rect) => doc.render(doc.layerRectToDoc(layer, rect)),
    };
  }

  /** Adds a layer above the active one and makes it active. */
  addLayer(name: string, canvas: OffscreenCanvas, at: LRect): void {
    this.structural('Paste layer', () => {
      const l = this.makeLayer(name, canvas, at);
      this.layers.splice(this.activeIndex + 1, 0, l);
      this.activeIndex++;
    });
  }

  removeLayer(index: number): void {
    if (this.layers.length < 2 || !this.layers[index]) return;
    this.structural('Delete layer', () => {
      this.layers.splice(index, 1);
      this.activeIndex = Math.min(Math.max(0, index - 1), this.layers.length - 1);
    });
  }

  /** Moves a layer up (+1, towards the top) or down (-1) in the stack. */
  reorderLayer(index: number, delta: 1 | -1): void {
    const to = index + delta;
    if (!this.layers[index] || to < 0 || to >= this.layers.length) return;
    this.structural(delta > 0 ? 'Layer up' : 'Layer down', () => {
      const [l] = this.layers.splice(index, 1);
      this.layers.splice(to, 0, l);
      this.activeIndex = to;
    });
  }

  setVisible(index: number, visible: boolean): void {
    const l = this.layers[index];
    if (!l || l.visible === visible) return;
    this.structural(visible ? 'Show layer' : 'Hide layer', () => (l.visible = visible));
  }

  /** Merges a layer into the one below; the result covers both layers' areas. */
  mergeDown(index: number): void {
    const upper = this.layers[index];
    const lower = this.layers[index - 1];
    if (!upper || !lower) return;
    this.structural('Merge down', () => {
      const parts = [lower, upper].filter((l) => l.visible);
      const bounds = parts.length ? parts.map(placement).reduce(unionRect) : placement(lower);
      const x = Math.floor(bounds.x);
      const y = Math.floor(bounds.y);
      const c = new OffscreenCanvas(Math.max(1, Math.ceil(bounds.x + bounds.w) - x), Math.max(1, Math.ceil(bounds.y + bounds.h) - y));
      const g = c.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      for (const l of parts) g.drawImage(l.canvas, l.x - x, l.y - y, l.w, l.h);
      Object.assign(lower, { canvas: c, x, y, w: c.width, h: c.height, visible: true });
      this.layers.splice(index, 1);
      this.activeIndex = index - 1;
    });
  }

  /** Moves/scales a layer (history entry from `from` to the layer's current placement, or to `to`). */
  setPlacement(layer: Layer, from: LRect, to: LRect = placement(layer), label = 'Move layer'): void {
    if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return;
    Object.assign(layer, from);
    this.structural(label, () => Object.assign(layer, to));
  }

  /** Live placement while dragging; finish with setPlacement for the history entry. */
  previewPlacement(layer: Layer, to: LRect): void {
    Object.assign(layer, to);
    this.render();
    this.changed(false);
  }

  /** Bakes pending scales into the layers' pixels, so pixel tools work 1:1. */
  rasterizeAll(): void {
    if (!this.layers.some((l) => this.needsRaster(l))) return;
    this.structural('Apply transform', () => {
      for (const l of this.layers) if (this.needsRaster(l)) this.rasterize(l);
    });
  }

  crop(r: Rect): void {
    const rect = clampRect(r, this.width, this.height);
    if (!rect) return;
    this.structural('Crop', () => {
      for (const l of this.layers) {
        this.rasterize(l);
        const part = intersectRect(placement(l), rect);
        if (part) {
          l.canvas = copyCanvas(l.canvas, part.w, part.h, part.x - l.x, part.y - l.y);
          Object.assign(l, { x: part.x - rect.x, y: part.y - rect.y, w: part.w, h: part.h });
        } else {
          l.canvas = new OffscreenCanvas(1, 1);
          Object.assign(l, { x: 0, y: 0, w: 1, h: 1 });
        }
      }
      this.width = rect.w;
      this.height = rect.h;
    });
  }

  flip(horizontal: boolean): void {
    this.structural(horizontal ? 'Flip horizontal' : 'Flip vertical', () => {
      for (const l of this.layers) {
        this.rasterize(l);
        const c = new OffscreenCanvas(l.canvas.width, l.canvas.height);
        const g = c.getContext('2d')!;
        g.translate(horizontal ? c.width : 0, horizontal ? 0 : c.height);
        g.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
        g.drawImage(l.canvas, 0, 0);
        l.canvas = c;
        Object.assign(l, flipRect(placement(l), horizontal, this.width, this.height));
      }
    });
  }

  rotate(clockwise: boolean): void {
    this.structural(clockwise ? 'Rotate right' : 'Rotate left', () => {
      for (const l of this.layers) {
        this.rasterize(l);
        const src = l.canvas;
        const c = new OffscreenCanvas(src.height, src.width);
        const g = c.getContext('2d')!;
        if (clockwise) {
          g.translate(src.height, 0);
          g.rotate(Math.PI / 2);
        } else {
          g.translate(0, src.width);
          g.rotate(-Math.PI / 2);
        }
        g.drawImage(src, 0, 0);
        l.canvas = c;
        Object.assign(l, rotateRect(placement(l), clockwise, this.width, this.height));
      }
      [this.width, this.height] = [this.height, this.width];
    });
  }

  /** Average colour of the active layer in a size×size square centred on (x, y), ignoring transparent pixels. */
  sample(x: number, y: number, size: number): [number, number, number] | undefined {
    const l = this.active;
    const p = this.toLayer(l, x, y);
    const half = Math.floor(size / 2);
    const rect = clampRect({ x: Math.floor(p.x) - half, y: Math.floor(p.y) - half, w: size, h: size }, l.canvas.width, l.canvas.height);
    if (!rect) return undefined;
    const d = l.canvas.getContext('2d')!.getImageData(rect.x, rect.y, rect.w, rect.h).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let wsum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      r += d[i] * a;
      g += d[i + 1] * a;
      b += d[i + 2] * a;
      wsum += a;
    }
    if (!wsum) return undefined;
    return [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)];
  }

  /** Visible layers flattened to the document size. */
  flatten(): OffscreenCanvas {
    if (!this.composite) return this.layers[0].canvas;
    const c = new OffscreenCanvas(this.width, this.height);
    this.drawLayers(c.getContext('2d')!);
    return c;
  }

  encode(format: ImageFormat, quality: number): Promise<Uint8Array> {
    return encodeCanvas(this.flatten(), format, quality);
  }

  /** RGBA of `layer` as placed in the document (document size; outside the layer is transparent). */
  layerPixels(layer: Layer): ImageData {
    const c = new OffscreenCanvas(this.width, this.height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(layer.canvas, layer.x, layer.y, layer.w, layer.h);
    return g.getImageData(0, 0, this.width, this.height);
  }

  private makeLayer(name: string, canvas: OffscreenCanvas, at: LRect): Layer {
    return { id: this.nextLayerId++, name, canvas, ...at, visible: true };
  }

  private needsRaster(l: Layer): boolean {
    return l.w !== l.canvas.width || l.h !== l.canvas.height || !Number.isInteger(l.x) || !Number.isInteger(l.y);
  }

  /** Only inside structural(): replaces the canvas, never modifies it. */
  private rasterize(l: Layer): void {
    if (!this.needsRaster(l)) return;
    const w = Math.max(1, Math.round(l.w));
    const h = Math.max(1, Math.round(l.h));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(l.canvas, 0, 0, w, h);
    Object.assign(l, { canvas: c, x: Math.round(l.x), y: Math.round(l.y), w, h });
  }

  private layerRectToDoc(l: Layer, r: Rect): Rect {
    const sx = l.w / l.canvas.width;
    const sy = l.h / l.canvas.height;
    return { x: l.x + r.x * sx, y: l.y + r.y * sy, w: r.w * sx, h: r.h * sy };
  }

  private isPlain(): boolean {
    const l = this.layers[0];
    return (
      this.layers.length === 1 &&
      l.visible &&
      l.x === 0 &&
      l.y === 0 &&
      l.canvas.width === this.width &&
      l.canvas.height === this.height &&
      l.w === this.width &&
      l.h === this.height
    );
  }

  private drawLayers(g: OffscreenCanvasRenderingContext2D): void {
    g.imageSmoothingQuality = 'high';
    for (const l of this.layers) if (l.visible) g.drawImage(l.canvas, l.x, l.y, l.w, l.h);
  }

  /** Re-renders the composite (all of it, or the part covering `rect` in document coordinates). */
  private render(rect?: Rect): void {
    if (this.isPlain()) {
      this.composite = undefined;
      return;
    }
    if (!this.composite || this.composite.width !== this.width || this.composite.height !== this.height) {
      this.composite = new OffscreenCanvas(this.width, this.height);
      rect = undefined;
    }
    const r = rect ? clampRect(rect, this.width, this.height) : { x: 0, y: 0, w: this.width, h: this.height };
    if (!r) return;
    const g = this.composite.getContext('2d')!;
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.clearRect(r.x, r.y, r.w, r.h);
    this.drawLayers(g);
    g.restore();
  }

  private commitRegion(layer: Layer, label: string, rect: Rect, before: OffscreenCanvas): void {
    const after = copyCanvas(layer.canvas, rect.w, rect.h, rect.x, rect.y);
    const put = (c: OffscreenCanvas) => {
      const g = layer.canvas.getContext('2d')!;
      g.clearRect(rect.x, rect.y, rect.w, rect.h);
      g.drawImage(c, rect.x, rect.y);
      this.render(this.layerRectToDoc(layer, rect));
      this.changed(false);
    };
    this.render(this.layerRectToDoc(layer, rect));
    this.push({ label, bytes: rect.w * rect.h * 8, undo: () => put(before), redo: () => put(after) });
    this.changed(false);
  }

  private state(): DocState {
    return {
      width: this.width,
      height: this.height,
      active: this.activeIndex,
      layers: this.layers.map((layer) => ({ layer, canvas: layer.canvas, x: layer.x, y: layer.y, w: layer.w, h: layer.h, visible: layer.visible })),
    };
  }

  /** `prev`: the size the viewer currently shows (fn() in structural() already changed this.width). */
  private restore(s: DocState, prev = { width: this.width, height: this.height }): void {
    const sizeChanged = s.width !== prev.width || s.height !== prev.height;
    this.width = s.width;
    this.height = s.height;
    this.layers = s.layers.map((ls) => Object.assign(ls.layer, { canvas: ls.canvas, x: ls.x, y: ls.y, w: ls.w, h: ls.h, visible: ls.visible }));
    this.activeIndex = s.active;
    this.render();
    this.changed(sizeChanged);
  }

  /** Runs a structural change and records it; memory cost = canvases only one side references. */
  private structural(label: string, fn: () => void): void {
    const before = this.state();
    fn();
    const after = this.state();
    const a = new Set(before.layers.map((l) => l.canvas));
    const b = new Set(after.layers.map((l) => l.canvas));
    let bytes = 64;
    for (const c of a) if (!b.has(c)) bytes += c.width * c.height * 4;
    for (const c of b) if (!a.has(c)) bytes += c.width * c.height * 4;
    this.push({ label, bytes, undo: () => this.restore(before), redo: () => this.restore(after) });
    this.restore(after, before);
  }

  private push(e: Omit<HistoryEntry, 'id'>): void {
    for (const r of this.redoStack) this.bytes -= r.bytes;
    this.redoStack = [];
    this.undoStack.push({ ...e, id: this.nextId++ });
    this.bytes += e.bytes;
    while (this.bytes > this.memoryLimitBytes && this.undoStack.length > 1) {
      this.bytes -= this.undoStack.shift()!.bytes;
    }
  }
}
