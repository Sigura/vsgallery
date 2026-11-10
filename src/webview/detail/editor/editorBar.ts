import { kohyaBuckets } from '../../../shared/buckets';
import type { BrushSettings } from './brush';
import type { CropTool } from './cropTool';
import type { EditDocument } from './document';
import type { EditorUiState, ToolName } from './imageEditor';

const SDXL = kohyaBuckets(1024, 256, 2048, 64);
const SD15 = kohyaBuckets(512, 256, 1024, 64);
const RATIOS: [string, number][] = [
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['3:2', 3 / 2],
  ['2:3', 2 / 3],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
];

export interface EditorBarHost {
  readonly ui: EditorUiState;
  readonly crop: CropTool;
  doc(): EditDocument | undefined;
  zoom(): number;
  selectionActive(): boolean;
  currentSize(): number;
  setTool(t: ToolName): void;
  setCurrentSize(v: number): void;
  setColor(hex: string, remember: boolean): void;
  cropOptionsChanged(): void;
  applyCrop(): void;
  persist(): void;
  refresh(): void;
  undo(): void;
  redo(): void;
  showBefore(on: boolean): void;
  save(mode: 'overwrite' | 'copy'): void;
  selClear(): void;
  selInvert(): void;
  selAll(): void;
  deselect(): void;
  smartFill(): void;
}

/** The editor toolbar: tool buttons, per-tool options and document actions. */
export class EditorBar {
  private readonly el: Record<string, HTMLElement>;

  constructor(
    private readonly bar: HTMLElement,
    private readonly host: EditorBarHost,
  ) {
    this.el = this.build();
  }

  setBefore(on: boolean): void {
    this.el.before.classList.toggle('on', on);
  }

  private build(): Record<string, HTMLElement> {
    const sdxl = SDXL.map((b) => `<option value="b:${b.w}x${b.h}">${b.w}×${b.h} (${(b.w / b.h).toFixed(2)})</option>`).join('');
    const sd15 = SD15.map((b) => `<option value="b:${b.w}x${b.h}">${b.w}×${b.h} (${(b.w / b.h).toFixed(2)})</option>`).join('');
    const ratios = RATIOS.map(([n, r]) => `<option value="ar:${r}">${n}</option>`).join('');
    this.bar.innerHTML = `
      <div class="seg tools" role="toolbar" aria-label="Tools">
        <button data-tool="pan" data-icon="pan" data-icon-only title="Pan (H) — Space+drag or middle button pans with any tool">Pan</button>
        <button data-tool="brush" data-icon="brush" data-icon-only title="Brush (B) — Ctrl+click (or Alt+click) picks a colour, Shift+click draws a line, Shift+drag resizes">Brush</button>
        <button data-tool="eraser" data-icon="eraser" data-icon-only title="Eraser (E) — Ctrl+click picks the brush colour">Eraser</button>
        <button data-tool="wet" data-icon="wet" data-icon-only title="Wet paint (R) — smudges the existing colours and mixes in the brush colour; Ctrl+click picks a colour">Wet</button>
        <button data-tool="clone" data-icon="clone" data-icon-only title="Clone stamp (S) — Alt+click sets the source">Clone</button>
        <button data-tool="heal" data-icon="heal" data-icon-only title="Heal (J) — paint over a spot, scratch or watermark; on release it is rebuilt from the surroundings">Heal</button>
        <button data-tool="picker" data-icon="picker" data-icon-only title="Eyedropper (I)">Picker</button>
        <button data-tool="crop" data-icon="crop" data-icon-only title="Crop (C) — Enter applies, Esc cancels">Crop</button>
        <button data-tool="move" data-icon="move" data-icon-only title="Move layer (V) — drag to move, corner handles scale (Shift keeps the ratio), arrow keys nudge. Ctrl+V or drop an image file to add a layer">Move</button>
        <button data-tool="selRect" data-icon="selRect" data-icon-only title="Rectangle selection (M) — Shift adds, Alt subtracts">Select</button>
        <button data-tool="lasso" data-icon="lasso" data-icon-only title="Freehand selection (L) — Shift adds, Alt subtracts">Lasso</button>
        <button data-tool="wand" data-icon="wand" data-icon-only title="Contiguous selection (W) — Shift adds, Alt subtracts">Wand</button>
      </div>
      <div class="opts" data-for="wand">
        <label title="Maximum difference per channel from the clicked pixel">Tolerance <input data-k="tolerance" type="number" min="0" max="255" step="1"></label>
      </div>
      <div class="opts" data-for="selRect lasso wand">
        <button data-k="selFill" title="Fill the selection from its surroundings (content-aware)">Fill</button>
        <button data-k="selClear" title="Make the selected pixels of the active layer transparent (Delete)">Clear</button>
        <button data-k="selInvert" title="Invert selection (Ctrl+Shift+I)">Invert</button>
        <button data-k="selAll" title="Select all (Ctrl+A)">All</button>
        <button data-k="selNone" title="Deselect (Esc or Ctrl+D)">Deselect</button>
      </div>
      <div class="opts" data-for="brush eraser wet clone heal">
        <label title="Brush size ([ and ])">Size <input data-k="size" type="range" min="1" max="500"></label>
        <span data-k="sizeInfo" class="info"></span>
        <select data-k="sizeMode" title="Screen px: the brush keeps its size on screen at any zoom">
          <option value="screen">Screen px</option>
          <option value="image">Image px</option>
        </select>
      </div>
      <div class="opts" data-for="brush eraser wet clone">
        <label>Hardness <input data-k="hardness" type="range" min="0" max="100"></label>
        <label>Opacity <input data-k="opacity" type="range" min="1" max="100"></label>
        <label>Flow <input data-k="flow" type="range" min="1" max="100"></label>
        <label>Spacing <input data-k="spacing" type="range" min="2" max="100"></label>
        <label title="Pen pressure controls size"><input data-k="pressureSize" type="checkbox"> Pressure size</label>
        <label title="Pen pressure controls flow"><input data-k="pressureOpacity" type="checkbox"> Pressure flow</label>
      </div>
      <div class="opts" data-for="wet">
        <label title="How much paint under the brush is dragged along">Wetness <input data-k="wetness" type="range" min="0" max="100"></label>
        <label title="How much brush colour is mixed in (0 = smudge only)">Mix <input data-k="mix" type="range" min="0" max="100"></label>
      </div>
      <div class="opts" data-for="clone">
        <label title="Copy from the visible image instead of the active layer"><input data-k="cloneMerged" type="checkbox"> Sample merged</label>
        <span class="info">Alt+click sets the source</span>
      </div>
      <div class="opts" data-for="brush picker wet">
        <input data-k="color" type="color" title="Brush colour">
        <span data-k="recent" class="recent"></span>
        <select data-k="sample" title="Eyedropper sample size">
          <option value="1">1 px</option>
          <option value="3">3×3</option>
          <option value="5">5×5</option>
        </select>
      </div>
      <div class="opts" data-for="crop">
        <select data-k="aspect" title="Aspect ratio">
          <option value="free">Free</option>
          <option value="orig">Original ratio</option>
          ${ratios}
          <optgroup label="SDXL buckets (1024²)">${sdxl}</optgroup>
          <optgroup label="SD 1.5 buckets (512²)">${sd15}</optgroup>
        </select>
        <select data-k="snap" title="Round the crop size down to a multiple of">
          <option value="1">No snap</option>
          <option value="8">Snap ÷8</option>
          <option value="64">Snap ÷64</option>
        </select>
        <span data-k="cropSize" class="info"></span>
        <button data-k="cropApply" title="Apply crop (Enter)">Apply</button>
        <button data-k="cropCancel" title="Cancel (Esc)">Cancel</button>
      </div>
      <span class="spacer"></span>
      <div class="seg">
        <button data-k="rotL" title="Rotate left">⟲</button>
        <button data-k="rotR" title="Rotate right">⟳</button>
        <button data-k="flipH" title="Flip horizontal">⇋</button>
        <button data-k="flipV" title="Flip vertical">⇵</button>
      </div>
      <div class="seg">
        <button data-k="undo" title="Undo (Ctrl+Z)">↶</button>
        <button data-k="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
      </div>
      <button data-k="before" title="Hold to see the original (or hold \\)">Before</button>
      <button data-k="save" title="Overwrite the image (a .bak backup is kept if enabled)">Save</button>
      <button data-k="saveCopy" title="Save as a new file next to it, with a copy of the caption">Save copy</button>`;
    const el: Record<string, HTMLElement> = {};
    this.bar.querySelectorAll<HTMLElement>('[data-k]').forEach((n) => (el[n.dataset.k!] = n));
    const input = (k: string) => el[k] as HTMLInputElement;
    const h = this.host;
    const ui = h.ui;
    const b = () => ui.brush;

    this.bar.querySelectorAll<HTMLElement>('[data-tool]').forEach((n) =>
      n.addEventListener('click', () => h.setTool(n.dataset.tool as ToolName)),
    );
    input('size').addEventListener('input', () => h.setCurrentSize(Number(input('size').value)));
    el.sizeMode.addEventListener('change', () => {
      b().sizeMode = (el.sizeMode as HTMLSelectElement).value as BrushSettings['sizeMode'];
      h.persist();
      h.refresh();
    });
    for (const k of ['hardness', 'opacity', 'flow', 'spacing'] as const) {
      input(k).addEventListener('input', () => {
        b()[k] = Number(input(k).value) / 100;
        h.persist();
      });
    }
    for (const k of ['pressureSize', 'pressureOpacity'] as const) {
      input(k).addEventListener('change', () => {
        b()[k] = input(k).checked;
        h.persist();
      });
    }
    input('color').addEventListener('change', () => h.setColor(input('color').value, true));
    el.recent.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).dataset.color;
      if (c) h.setColor(c, false);
    });
    el.sample.addEventListener('change', () => {
      ui.sampleSize = Number((el.sample as HTMLSelectElement).value);
      h.persist();
    });
    el.aspect.addEventListener('change', () => {
      ui.cropAspect = (el.aspect as HTMLSelectElement).value;
      h.cropOptionsChanged();
      h.persist();
    });
    el.snap.addEventListener('change', () => {
      ui.cropSnap = Number((el.snap as HTMLSelectElement).value);
      h.cropOptionsChanged();
      h.persist();
    });
    input('tolerance').addEventListener('change', () => {
      const v = Number(input('tolerance').value);
      ui.tolerance = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 8;
      h.persist();
      h.refresh();
    });
    el.selClear.addEventListener('click', () => h.selClear());
    el.selInvert.addEventListener('click', () => h.selInvert());
    el.selAll.addEventListener('click', () => h.selAll());
    el.selNone.addEventListener('click', () => h.deselect());
    el.selFill.addEventListener('click', () => h.smartFill());
    for (const k of ['wetness', 'mix'] as const) {
      input(k).addEventListener('input', () => {
        ui.wet[k] = Number(input(k).value) / 100;
        h.persist();
      });
    }
    input('cloneMerged').addEventListener('change', () => {
      ui.cloneMerged = input('cloneMerged').checked;
      h.persist();
    });
    el.cropApply.addEventListener('click', () => h.applyCrop());
    el.cropCancel.addEventListener('click', () => h.crop.reset());
    el.rotL.addEventListener('click', () => h.doc()?.rotate(false));
    el.rotR.addEventListener('click', () => h.doc()?.rotate(true));
    el.flipH.addEventListener('click', () => h.doc()?.flip(true));
    el.flipV.addEventListener('click', () => h.doc()?.flip(false));
    el.undo.addEventListener('click', () => h.undo());
    el.redo.addEventListener('click', () => h.redo());
    el.before.addEventListener('pointerdown', () => h.showBefore(true));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.before.addEventListener(ev, () => h.showBefore(false));
    el.save.addEventListener('click', () => h.save('overwrite'));
    el.saveCopy.addEventListener('click', () => h.save('copy'));
    return el;
  }

  /** Syncs every control with the editor state. */
  refresh(): void {
    const h = this.host;
    const ui = h.ui;
    const b = ui.brush;
    const el = this.el;
    this.bar.querySelectorAll<HTMLElement>('[data-tool]').forEach((n) => n.classList.toggle('on', n.dataset.tool === ui.tool));
    this.bar.querySelectorAll<HTMLElement>('.opts').forEach((n) => (n.hidden = !n.dataset.for!.split(' ').includes(ui.tool)));
    const set = (k: string, v: string) => {
      const n = el[k] as HTMLInputElement;
      if (n.value !== v) n.value = v;
    };
    set('size', String(h.currentSize()));
    (el.sizeMode as HTMLSelectElement).value = b.sizeMode;
    const zoom = h.zoom();
    el.sizeInfo.textContent =
      b.sizeMode === 'screen'
        ? `${b.sizeScreen} px screen = ${(b.sizeScreen / zoom).toFixed(1)} px image`
        : `${b.sizeImage} px image = ${(b.sizeImage * zoom).toFixed(0)} px screen`;
    set('hardness', String(Math.round(b.hardness * 100)));
    set('opacity', String(Math.round(b.opacity * 100)));
    set('flow', String(Math.round(b.flow * 100)));
    set('spacing', String(Math.round(b.spacing * 100)));
    (el.pressureSize as HTMLInputElement).checked = b.pressureSize;
    (el.pressureOpacity as HTMLInputElement).checked = b.pressureOpacity;
    set('color', b.color);
    set('sample', String(ui.sampleSize));
    set('aspect', ui.cropAspect);
    set('snap', String(ui.cropSnap));
    set('tolerance', String(ui.tolerance));
    set('wetness', String(Math.round(ui.wet.wetness * 100)));
    set('mix', String(Math.round(ui.wet.mix * 100)));
    (el.cloneMerged as HTMLInputElement).checked = ui.cloneMerged;
    el.recent.replaceChildren(
      ...ui.recent.map((c) => {
        const s = document.createElement('span');
        s.className = 'swatch';
        s.dataset.color = c;
        s.title = c;
        s.style.background = c;
        return s;
      }),
    );
    const r = h.crop.result();
    el.cropSize.textContent = r ? h.crop.label(r) : 'Drag on the image to select';
    (el.cropApply as HTMLButtonElement).disabled = !r;
    const doc = h.doc();
    (el.undo as HTMLButtonElement).disabled = !doc?.canUndo;
    (el.redo as HTMLButtonElement).disabled = !doc?.canRedo;
    for (const k of ['save', 'rotL', 'rotR', 'flipH', 'flipV', 'saveCopy', 'before']) (el[k] as HTMLButtonElement).disabled = !doc;
    el.save.classList.toggle('primary', !!doc?.dirty);
    const sel = !!doc && h.selectionActive();
    (el.selClear as HTMLButtonElement).disabled = !sel;
    (el.selFill as HTMLButtonElement).disabled = !sel;
    (el.selNone as HTMLButtonElement).disabled = !sel;
    (el.selInvert as HTMLButtonElement).disabled = !doc;
    (el.selAll as HTMLButtonElement).disabled = !doc;
  }
}
