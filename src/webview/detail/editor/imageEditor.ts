import { snapAngle, type Size } from '../../../shared/buckets';
import { fitScale } from '../../../shared/layerMath';
import type { GallerySettings, WebviewToHost } from '../../../shared/protocol';
import type { ImagePoint, ImageViewer, ViewTransform, ViewerTool } from '../imageViewer';
import { BrushStroke, type BrushSettings } from './brush';
import { CropTool, type CropOptions } from './cropTool';
import { EditDocument, formatOf } from './document';
import { EditorBar, type EditorBarHost } from './editorBar';
import { LayersPanel } from './layersPanel';
import { MoveTool } from './moveTool';
import { installPasteAndDrop } from './pasteLayer';
import { clearSelected, Selection, selectionTools, type PreviewTool, type SelectToolName } from './selection';
import { WetStroke, type WetSettings } from './wetBrush';
import { CloneSource, CloneStroke } from './cloneTool';
import { SmartPatcher } from './smartPatch';

export type ToolName = 'pan' | 'brush' | 'eraser' | 'wet' | 'clone' | 'picker' | 'crop' | 'move' | SelectToolName;

const PAINT_TOOLS: readonly ToolName[] = ['brush', 'eraser', 'wet', 'clone'];

export interface EditorUiState {
  tool: ToolName;
  brush: BrushSettings;
  sampleSize: number;
  recent: string[];
  cropAspect: string;
  cropSnap: number;
  /** Magic wand: maximum per-channel difference from the clicked pixel. */
  tolerance: number;
  wet: WetSettings;
  /** Clone stamp copies from the merged visible image instead of the active layer. */
  cloneMerged: boolean;
}

export interface EditorHost {
  post(m: WebviewToHost): void;
  settings(): GallerySettings;
  state(): Partial<EditorUiState> | undefined;
  saveState(s: EditorUiState): void;
  notice(text: string): void;
  /** History or dirty state changed. */
  changed(): void;
}

const MAX_RECENT = 12;
const SHIFT_DRAG_PX = 3;

const toHex = (rgb: [number, number, number]) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function parseAspect(v: string, doc: EditDocument | undefined): CropOptions['aspect'] {
  if (v.startsWith('ar:')) return Number(v.slice(3));
  if (v.startsWith('b:')) {
    const [w, h] = v.slice(2).split('x').map(Number);
    return w / h;
  }
  if (v === 'orig' && doc) return doc.width / doc.height;
  return null;
}

function parseBucket(v: string): Size | undefined {
  if (!v.startsWith('b:')) return undefined;
  const [w, h] = v.slice(2).split('x').map(Number);
  return { w, h };
}

/**
 * Pixel editing on top of the image viewer: brush/eraser with screen- or image-pixel size,
 * Shift+click lines, eyedropper, crop, flips/rotations, undo/redo, before/after and save.
 */
export class ImageEditor {
  private doc: EditDocument | undefined;
  private id: string | undefined;
  private name = '';
  private ui: EditorUiState;
  private stroke: BrushStroke | WetStroke | CloneStroke | undefined;
  private readonly cloneSource = new CloneSource();
  private readonly patcher = new SmartPatcher(document.body.dataset.patchWorker!);
  private strokeFrame = 0;
  private lastPoint: ImagePoint | undefined;
  private cursorPos: ImagePoint | undefined;
  private shiftDrag: { x: number; startSize: number; resizing: boolean; p: ImagePoint; ctrl: boolean } | undefined;
  private picking = false;
  private beforeShown = false;
  private readonly expectedWrites = new Set<string>();
  private readonly pendingMarks = new Map<string, number>();
  private readonly crop: CropTool;
  private readonly moveTool: MoveTool;
  private readonly selTools: Record<SelectToolName, PreviewTool>;
  private readonly selection = new Selection();
  private readonly layersPanel: LayersPanel;
  private antsTimer: ReturnType<typeof setInterval> | undefined;
  private antsPhase = 0;
  /** Offset of the layer the current stroke paints on (stroke coordinates are layer pixels). */
  private strokeOrigin = { x: 0, y: 0 };
  private readonly tools: Record<ToolName, ViewerTool | undefined>;
  private readonly bar: EditorBar;

  constructor(
    barEl: HTMLElement,
    private readonly viewer: ImageViewer,
    private readonly host: EditorHost,
  ) {
    const saved = host.state();
    this.ui = {
      tool: saved?.tool ?? 'pan',
      brush: {
        sizeScreen: 24,
        sizeImage: 16,
        sizeMode: host.settings().brushSizeMode,
        hardness: 0.8,
        opacity: 1,
        flow: 1,
        spacing: 0.1,
        pressureSize: true,
        pressureOpacity: false,
        color: '#000000',
        ...saved?.brush,
      },
      sampleSize: saved?.sampleSize ?? 1,
      recent: saved?.recent ?? [],
      cropAspect: saved?.cropAspect ?? 'free',
      cropSnap: saved?.cropSnap ?? host.settings().snapMultiple,
      tolerance: saved?.tolerance ?? 8,
      wet: { wetness: 0.6, mix: 0.2, ...saved?.wet },
      cloneMerged: saved?.cloneMerged ?? false,
    };
    this.crop = new CropTool(() => this.doc, viewer, () => this.refresh(), this.cropOptions());
    this.moveTool = new MoveTool(
      () => this.doc,
      () => viewer.view,
      (c) => {
        this.moveTool.cursor = c;
        viewer.refreshCursor();
      },
    );
    this.selTools = selectionTools({
      doc: () => this.doc,
      selection: this.selection,
      tolerance: () => this.ui.tolerance,
      zoom: () => viewer.zoom,
      changed: () => this.refresh(),
      requestDraw: () => viewer.requestDraw(),
    });
    const paint = this.paintTool();
    this.tools = {
      pan: undefined,
      brush: paint,
      eraser: paint,
      wet: paint,
      clone: paint,
      picker: this.pickerTool(),
      crop: this.crop,
      move: this.moveTool,
      ...this.selTools,
    };
    const viewerHost = viewer.canvas.parentElement!;
    this.layersPanel = new LayersPanel(viewerHost, () => this.doc);
    installPasteAndDrop(
      viewerHost,
      () => !!this.doc && !this.stroke && viewerHost.offsetParent !== null,
      (blob, name) => void this.addImageLayer(blob, name),
    );
    this.bar = new EditorBar(barEl, this.barHost());
    viewer.overlay = (ctx, v) => this.drawOverlay(ctx, v);
    window.addEventListener('keyup', (e) => {
      if (e.key === '\\') this.showBefore(false);
    });
    window.addEventListener('blur', () => this.showBefore(false));
    this.setTool(this.ui.tool);
  }

  get dirty(): boolean {
    return !!this.doc?.dirty;
  }

  get currentId(): string | undefined {
    return this.id;
  }

  /** The next file change of `id` is our own overwrite and must not reload the image. */
  expectsWrite(id: string): boolean {
    return this.expectedWrites.has(id);
  }

  load(id: string, name: string, source: ImageBitmap): void {
    this.endStroke();
    this.id = id;
    this.name = name;
    this.lastPoint = undefined;
    this.beforeShown = false;
    this.selection.clear();
    this.cloneSource.clear();
    this.doc = new EditDocument(source, this.host.settings().undoMemoryMB * 1048576, (sizeChanged) => {
      this.selection.fit(this.doc!.width, this.doc!.height);
      if (sizeChanged) this.viewer.setImage(this.doc!.canvas, this.doc!.width, this.doc!.height);
      else this.viewer.setImage(this.doc!.canvas, this.doc!.width, this.doc!.height, true);
      this.refresh();
    });
    this.crop.rect = undefined;
    if (this.ui.tool === 'crop') this.crop.setOptions(this.cropOptions());
    this.viewer.setImage(this.doc.canvas, this.doc.width, this.doc.height, true);
    this.refresh();
  }

  unload(): void {
    this.endStroke();
    this.selection.clear();
    this.doc = undefined;
    this.id = undefined;
    this.refresh();
  }

  discard(): void {
    this.unload();
  }

  /** Encodes the current pixels and asks the host to write them. Resolves once the data is sent. */
  async save(mode: 'overwrite' | 'copy'): Promise<void> {
    const doc = this.doc;
    const id = this.id;
    if (!doc || !id) return;
    this.endStroke();
    const mark = doc.historyMark();
    const q = this.host.settings().jpegQuality;
    let data: Uint8Array;
    try {
      data = await doc.encode(formatOf(this.name), q);
    } catch (e) {
      this.host.notice(`Encoding failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (mode === 'overwrite') {
      this.expectedWrites.add(id);
      this.pendingMarks.set(id, mark);
    }
    this.host.post({ type: 'saveImage', id, mode, data });
  }

  saved(id: string, mode: 'overwrite' | 'copy', newId: string | undefined, error: string | undefined): void {
    if (mode === 'overwrite') {
      this.expectedWrites.delete(id);
      const mark = this.pendingMarks.get(id);
      this.pendingMarks.delete(id);
      if (!error && mark !== undefined && id === this.id) this.doc?.markSaved(mark);
    }
    if (error) this.host.notice(`Saving image failed: ${error}`);
    else if (mode === 'copy' && newId) this.host.notice(`Saved copy as ${newId}`);
    this.refresh();
  }

  /** Returns true when the key was an editor shortcut. */
  handleKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (ctrl && k === 'y') {
      this.redo();
      return true;
    }
    if (ctrl && this.doc && !this.stroke) {
      if (k === 'd' && !e.shiftKey) return this.deselect();
      if (k === 'i' && e.shiftKey) {
        this.selection.invert(this.doc.width, this.doc.height);
        this.refresh();
        return true;
      }
      if (k === 'a' && !e.shiftKey) {
        this.selection.all(this.doc.width, this.doc.height);
        this.refresh();
        return true;
      }
    }
    if (ctrl || e.altKey) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selection.active && this.doc && !this.stroke) {
        clearSelected(this.doc, this.selection);
        return true;
      }
      // With a selection tool, Delete never falls through to deleting the image file.
      return this.ui.tool in this.selTools;
    }
    if (e.key === 'Escape' && this.selection.active && this.ui.tool !== 'crop') return this.deselect();
    if (this.ui.tool === 'move' && e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
      if (d) this.moveTool.nudge(d[0], d[1]);
      return true;
    }
    if (e.key === '\\') {
      if (!e.repeat) this.showBefore(true);
      return true;
    }
    if (this.ui.tool === 'crop' && this.crop.rect) {
      if (e.key === 'Enter') {
        this.applyCrop();
        return true;
      }
      if (e.key === 'Escape') {
        this.crop.reset();
        return true;
      }
    }
    const tools: Record<string, ToolName> = {
      h: 'pan',
      b: 'brush',
      e: 'eraser',
      i: 'picker',
      r: 'wet',
      s: 'clone',
      c: 'crop',
      v: 'move',
      m: 'selRect',
      l: 'lasso',
      w: 'wand',
    };
    if (tools[k]) {
      this.setTool(tools[k]);
      return true;
    }
    if (e.key === '[' || e.key === ']') {
      this.scaleBrush(e.key === ']' ? 1.15 : 1 / 1.15);
      return true;
    }
    return false;
  }

  private deselect(): boolean {
    if (!this.selection.active) return false;
    this.selection.clear();
    this.refresh();
    return true;
  }

  /** Adds an image as a new layer centred in the view, scaled down to fit the document; switches to Move. */
  private async addImageLayer(blob: Blob, name: string): Promise<void> {
    const d = this.doc;
    if (!d) return;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob);
    } catch (e) {
      this.host.notice(`Cannot read the pasted image: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (d !== this.doc) return bmp.close();
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    const s = fitScale(canvas.width, canvas.height, d.width, d.height);
    const w = canvas.width * s;
    const h = canvas.height * s;
    const r = this.viewer.canvas.getBoundingClientRect();
    const c = this.viewer.toImage(r.left + r.width / 2, r.top + r.height / 2);
    d.rasterizeAll();
    d.addLayer(name, canvas, { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h });
    this.setTool('move');
    this.host.notice(s < 1 ? `Pasted as a new layer, scaled to ${Math.round(s * 100)}%` : 'Pasted as a new layer');
  }

  private cropOptions(): CropOptions {
    return {
      aspect: parseAspect(this.ui.cropAspect, this.doc),
      snap: this.ui.cropSnap,
      bucket: parseBucket(this.ui.cropAspect),
    };
  }

  private persist(): void {
    this.host.saveState(this.ui);
  }

  private setTool(t: ToolName): void {
    if (this.stroke) return;
    if (this.ui.tool === 'crop' && t !== 'crop') this.crop.reset();
    // A pending layer scale becomes pixels as soon as another tool is used.
    if (this.ui.tool === 'move' && t !== 'move') this.doc?.rasterizeAll();
    this.ui.tool = t;
    this.viewer.tool = this.tools[t];
    if (t === 'crop') this.crop.setOptions(this.cropOptions());
    this.persist();
    this.refresh();
  }

  /** Brush diameter in image pixels: screen-pixel sizes stay constant on screen at any zoom. */
  private diameter(): number {
    const b = this.ui.brush;
    return b.sizeMode === 'screen' ? b.sizeScreen / this.viewer.zoom : b.sizeImage;
  }

  private scaleBrush(f: number): void {
    const b = this.ui.brush;
    if (b.sizeMode === 'screen') b.sizeScreen = clampSize(Math.round(b.sizeScreen * f) || b.sizeScreen + Math.sign(f - 1));
    else b.sizeImage = clampSize(Math.round(b.sizeImage * f) || b.sizeImage + Math.sign(f - 1));
    this.persist();
    this.refresh();
  }

  private setColor(hex: string, remember: boolean): void {
    this.ui.brush.color = hex;
    if (remember) this.remember(hex);
    this.persist();
    this.refresh();
  }

  private remember(hex: string): void {
    this.ui.recent = [hex, ...this.ui.recent.filter((c) => c !== hex)].slice(0, MAX_RECENT);
  }

  private pick(p: ImagePoint): void {
    const rgb = this.doc?.sample(p.x, p.y, this.ui.sampleSize);
    if (rgb) this.setColor(toHex(rgb), false);
  }

  /** Document point → pixel of the layer being painted. */
  private toStroke(p: ImagePoint): ImagePoint {
    return { x: p.x - this.strokeOrigin.x, y: p.y - this.strokeOrigin.y, pressure: p.pressure };
  }

  private beginStroke(p: ImagePoint): BrushStroke | WetStroke | CloneStroke | undefined {
    const d = this.doc;
    if (!d) return undefined;
    d.rasterizeAll();
    const eraser = this.ui.tool === 'eraser';
    if (!eraser) this.remember(this.ui.brush.color);
    const layer = d.active;
    this.strokeOrigin = { x: layer.x, y: layer.y };
    const surface = d.surface();
    const settings = { ...this.ui.brush };
    if (this.ui.tool === 'wet') {
      this.stroke = new WetStroke(surface, settings, { ...this.ui.wet }, this.diameter());
    } else if (this.ui.tool === 'clone') {
      const off = this.cloneSource.offsetFor(p.x, p.y);
      if (!off) {
        this.host.notice('Alt+click sets the clone source');
        return undefined;
      }
      // With one layer the merged image is that layer, which the stroke's own snapshot already covers.
      const merged = this.ui.cloneMerged && d.layers.length > 1;
      this.stroke = new CloneStroke(surface, settings, this.diameter(), merged ? d.flatten() : undefined, (x, y) =>
        merged ? { x: x + layer.x + off.x, y: y + layer.y + off.y } : { x: x + off.x, y: y + off.y },
      );
    } else {
      this.stroke = new BrushStroke(surface, settings, this.diameter(), eraser);
    }
    this.stroke.begin(this.toStroke(p));
    this.scheduleRender();
    return this.stroke;
  }

  private scheduleRender(): void {
    if (this.strokeFrame) return;
    this.strokeFrame = requestAnimationFrame(() => {
      this.strokeFrame = 0;
      this.stroke?.render();
      this.viewer.requestDraw();
    });
  }

  private endStroke(): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = undefined;
    cancelAnimationFrame(this.strokeFrame);
    this.strokeFrame = 0;
    const last = s.lastPoint;
    this.lastPoint = last && { x: last.x + this.strokeOrigin.x, y: last.y + this.strokeOrigin.y, pressure: last.pressure };
    s.end();
    this.persist();
    this.viewer.requestDraw();
  }

  private paintTool(): ViewerTool {
    return {
      cursor: 'none',
      down: (e, p) => {
        if (e.altKey && this.ui.tool === 'clone') {
          this.cloneSource.set(p.x, p.y);
          this.host.notice('Clone source set; the first stroke fixes the offset');
          this.viewer.requestDraw();
          return;
        }
        if (e.altKey) {
          this.picking = true;
          this.pick(p);
          return;
        }
        if (e.shiftKey) {
          this.shiftDrag = { x: e.clientX, startSize: this.currentSize(), resizing: false, p, ctrl: e.ctrlKey || e.metaKey };
          return;
        }
        this.beginStroke(p);
      },
      move: (e, pts) => {
        const last = pts.at(-1)!;
        if (this.picking) {
          this.pick(last);
          return;
        }
        const sd = this.shiftDrag;
        if (sd) {
          if (!sd.resizing && Math.abs(e.clientX - sd.x) > SHIFT_DRAG_PX) sd.resizing = true;
          if (sd.resizing) this.setCurrentSize(sd.startSize + (e.clientX - sd.x) * (this.ui.brush.sizeMode === 'screen' ? 1 : 1 / this.viewer.zoom));
          return;
        }
        this.cursorPos = last;
        if (!this.stroke) return;
        for (const p of pts) this.stroke.to(this.toStroke(p));
        this.scheduleRender();
      },
      up: (e) => {
        if (this.picking) {
          this.picking = false;
          this.remember(this.ui.brush.color);
          this.persist();
          this.refresh();
          return;
        }
        const sd = this.shiftDrag;
        if (sd) {
          this.shiftDrag = undefined;
          if (!sd.resizing) this.drawLine(sd.p, sd.ctrl || e.ctrlKey || e.metaKey);
          return;
        }
        this.endStroke();
      },
      hover: (p) => {
        this.cursorPos = p;
        this.viewer.requestDraw();
      },
    };
  }

  /** Shift+click: straight stroke from the end of the previous stroke; Ctrl snaps to 15°. */
  private drawLine(target: ImagePoint, snap: boolean): void {
    const from = this.lastPoint;
    if (!from) {
      this.beginStroke(target);
      this.endStroke();
      return;
    }
    let to = { ...target, pressure: 1 };
    if (snap) {
      const d = snapAngle(target.x - from.x, target.y - from.y, 15);
      to = { x: from.x + d.dx, y: from.y + d.dy, pressure: 1 };
    }
    const s = this.beginStroke({ ...from, pressure: 1 });
    s?.to(this.toStroke(to));
    this.endStroke();
  }

  private currentSize(): number {
    const b = this.ui.brush;
    return b.sizeMode === 'screen' ? b.sizeScreen : b.sizeImage;
  }

  private setCurrentSize(v: number): void {
    const b = this.ui.brush;
    if (b.sizeMode === 'screen') b.sizeScreen = clampSize(Math.round(v));
    else b.sizeImage = clampSize(Math.round(v));
    this.refresh();
    this.viewer.requestDraw();
  }

  private pickerTool(): ViewerTool {
    return {
      cursor: 'crosshair',
      down: (_e, p) => {
        this.picking = true;
        this.pick(p);
      },
      move: (_e, pts) => {
        if (this.picking) this.pick(pts.at(-1)!);
      },
      up: () => {
        this.picking = false;
        this.remember(this.ui.brush.color);
        this.persist();
        this.refresh();
      },
    };
  }

  private applyCrop(): void {
    const r = this.crop.result();
    if (!r || !this.doc) return;
    this.doc.crop(r);
    this.crop.reset();
    if (this.ui.cropAspect !== 'free') this.crop.setOptions(this.cropOptions());
  }

  private undo(): void {
    if (this.stroke || !this.doc) return;
    this.doc.undo();
    this.lastPoint = undefined;
    this.refresh();
  }

  private redo(): void {
    if (this.stroke || !this.doc) return;
    this.doc.redo();
    this.refresh();
  }

  private showBefore(on: boolean): void {
    const d = this.doc;
    if (!d || on === this.beforeShown) return;
    this.beforeShown = on;
    if (on) this.viewer.setImage(d.original, d.original.width, d.original.height, true);
    else this.viewer.setImage(d.canvas, d.width, d.height, true);
    this.bar.setBefore(on);
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, v: ViewTransform): void {
    if (this.beforeShown) return;
    this.selection.draw(ctx, v, this.antsPhase);
    if (this.ui.tool === 'move') {
      this.moveTool.draw(ctx, v);
      return;
    }
    if (this.ui.tool in this.selTools) {
      this.selTools[this.ui.tool as SelectToolName].drawPreview(ctx, v);
      return;
    }
    if (this.ui.tool === 'crop') {
      this.crop.draw(ctx, v);
      return;
    }
    const p = this.cursorPos;
    if (!PAINT_TOOLS.includes(this.ui.tool) || !p) return;
    if (this.ui.tool === 'clone') this.drawCloneSource(ctx, v, p);
    const cx = v.tx + p.x * v.scale;
    const cy = v.ty + p.y * v.scale;
    const r = Math.max(1, (this.diameter() * v.scale) / 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - 0.5, cy - 0.5, 1, 1);
    ctx.restore();
  }

  /** Crosshair where the clone stamp copies from: the set point, or the cursor plus the fixed offset. */
  private drawCloneSource(ctx: CanvasRenderingContext2D, v: ViewTransform, cursor: ImagePoint): void {
    const src = this.cloneSource;
    const at = src.offset ? { x: cursor.x + src.offset.x, y: cursor.y + src.offset.y } : src.point;
    if (!at) return;
    const x = v.tx + at.x * v.scale;
    const y = v.ty + at.y * v.scale;
    ctx.save();
    for (const [w, c] of [
      [3, 'rgba(0, 0, 0, 0.6)'],
      [1, 'rgba(255, 255, 255, 0.9)'],
    ] as const) {
      ctx.lineWidth = w;
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.moveTo(x - 7, y);
      ctx.lineTo(x + 7, y);
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x, y + 7);
      ctx.stroke();
    }
    ctx.restore();
  }

  private async smartFill(): Promise<void> {
    const d = this.doc;
    if (!d || this.stroke) return;
    this.host.notice('Filling the selection…');
    const error = await this.patcher.fill(d, this.selection);
    this.host.notice(error ?? 'Filled the selection from its surroundings');
  }

  private refresh(): void {
    if (!this.bar) return;
    this.bar.refresh();
    this.layersPanel.refresh();
    this.animateAnts(!!this.doc && this.selection.active);
    this.viewer.requestDraw();
    this.host.changed();
  }

  private barHost(): EditorBarHost {
    return {
      ui: this.ui,
      crop: this.crop,
      doc: () => this.doc,
      zoom: () => this.viewer.zoom,
      selectionActive: () => this.selection.active,
      currentSize: () => this.currentSize(),
      setTool: (t) => this.setTool(t),
      setCurrentSize: (v) => this.setCurrentSize(v),
      setColor: (hex, remember) => this.setColor(hex, remember),
      cropOptionsChanged: () => this.crop.setOptions(this.cropOptions()),
      applyCrop: () => this.applyCrop(),
      persist: () => this.persist(),
      refresh: () => this.refresh(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      showBefore: (on) => this.showBefore(on),
      save: (mode) => void this.save(mode),
      selClear: () => {
        if (this.doc) clearSelected(this.doc, this.selection);
      },
      selInvert: () => {
        if (!this.doc) return;
        this.selection.invert(this.doc.width, this.doc.height);
        this.refresh();
      },
      selAll: () => {
        if (!this.doc) return;
        this.selection.all(this.doc.width, this.doc.height);
        this.refresh();
      },
      deselect: () => this.deselect(),
      smartFill: () => void this.smartFill(),
    };
  }

  private animateAnts(on: boolean): void {
    if (on === (this.antsTimer !== undefined)) return;
    clearInterval(this.antsTimer);
    this.antsTimer = undefined;
    if (on) {
      this.antsTimer = setInterval(() => {
        this.antsPhase = (this.antsPhase + 1) % 8;
        if (this.viewer.canvas.offsetParent !== null) this.viewer.requestDraw();
      }, 120);
    }
  }

  /** Keeps the size label in sync with zoom changes. */
  zoomChanged(): void {
    this.refresh();
  }
}

function clampSize(v: number): number {
  return Math.max(1, Math.min(500, v));
}
