import type { ImageEntry, ResizeOutput } from '../../shared/protocol';
import { bucketsFor, planResize, type ResizeMode, type ResizeOptions, type ResizePlan } from '../../shared/resizePlan';

export interface ResizeUiState extends ResizeOptions {
  output: 'overwrite' | 'folder';
  folder?: string;
}

export interface ResizeDialogHost {
  entry(id: string): ImageEntry | undefined;
  previewUrl(e: ImageEntry): string | undefined;
  /** Dataset folder path; the default output folder is next to it. */
  folderPath(): string;
  editorBackup(): boolean;
  saveState(s: ResizeUiState): void;
}

const MAX_ROWS = 300;
const PREVIEW_W = 360;
const PREVIEW_H = 240;

const SKIP_TEXT: Record<Extract<ResizePlan, { action: 'skip' }>['reason'], string> = {
  unchanged: 'already fits',
  upscale: 'skipped: would need upscaling',
  tooSmall: 'skipped: smaller than the snap multiple',
};

function describe(p: ResizePlan): string {
  if (p.action === 'skip') return SKIP_TEXT[p.reason];
  const what = [p.cropped && 'crop', p.scaled && 'scale'].filter(Boolean).join(' + ');
  return `${p.out.w}×${p.out.h} (${what})`;
}

/** Batch resize options with a per-image plan and a crop preview; resolves with what to run, or undefined. */
export class ResizeDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly $ = <T extends HTMLElement>(sel: string) => this.dialog.querySelector(sel) as T;
  private ids: readonly string[] = [];
  private plans = new Map<string, ResizePlan | undefined>();
  private previewId: string | undefined;
  private previewImg: HTMLImageElement | undefined;

  constructor(
    private readonly host: ResizeDialogHost,
    private state: ResizeUiState,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'leave-dialog resize-dialog';
    this.dialog.innerHTML = `
      <form method="dialog">
        <p class="resize-targets"></p>
        <div class="resize-options">
          <label>Mode
            <select name="mode">
              <option value="bucket">Kohya bucket (crop to aspect, scale)</option>
              <option value="maxSide">Long side at most…</option>
              <option value="shortSide">Short side to…</option>
              <option value="snap">Only crop to multiple</option>
            </select>
          </label>
          <label data-for="bucket">Base
            <select name="bucketBase">
              <option value="512">512 (SD 1.5)</option>
              <option value="768">768 (SD 2.x)</option>
              <option value="1024">1024 (SDXL)</option>
            </select>
          </label>
          <label data-for="maxSide shortSide">Size <input name="size" type="number" min="64" max="8192" step="8"></label>
          <label data-for="maxSide shortSide snap">Multiple
            <select name="snap"><option value="1">off</option><option value="8">8</option><option value="64">64</option></select>
          </label>
          <label><input name="upscale" type="checkbox"> Allow upscaling</label>
        </div>
        <div class="resize-options">
          <label><input type="radio" name="output" value="overwrite"> Overwrite originals</label>
          <label><input type="radio" name="output" value="folder"> Write to folder</label>
          <input name="folder" type="text" class="resize-folder" spellcheck="false" aria-label="Output folder">
        </div>
        <p class="hint resize-output-hint"></p>
        <p class="resize-summary"></p>
        <div class="resize-body">
          <div class="resize-list" role="listbox" aria-label="Planned changes"></div>
          <div class="resize-preview"><canvas width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas><p class="hint resize-preview-text"></p></div>
        </div>
        <div class="dialog-buttons">
          <button value="start" class="primary">Start</button>
          <button value="cancel">Cancel</button>
        </div>
      </form>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector('form')!.addEventListener('input', () => this.readForm());
    this.$('.resize-list').addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id) this.showPreview(id);
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(ids: readonly string[], what: string): Promise<{ opts: ResizeOptions; output: ResizeOutput } | undefined> {
    this.ids = ids;
    this.$('.resize-targets').textContent = `Resize ${what}. Captions are kept; with "Write to folder" they are copied along.`;
    this.state.folder ||= `${this.host.folderPath()}_resized`;
    this.writeForm();
    this.update();
    this.dialog.returnValue = '';
    this.dialog.showModal();
    return new Promise((resolve) => {
      this.dialog.addEventListener(
        'close',
        () => {
          this.previewImg = undefined;
          if (this.dialog.returnValue !== 'start') return resolve(undefined);
          const { output, folder, ...opts } = this.state;
          resolve({ opts, output: output === 'folder' ? { kind: 'folder', path: folder!.trim() } : { kind: 'overwrite' } });
        },
        { once: true },
      );
    });
  }

  private field<T extends HTMLInputElement | HTMLSelectElement>(name: string): T {
    return this.dialog.querySelector(`[name="${name}"]`) as T;
  }

  private writeForm(): void {
    const s = this.state;
    this.field<HTMLSelectElement>('mode').value = s.mode;
    this.field<HTMLSelectElement>('bucketBase').value = String(s.bucketBase);
    this.field<HTMLInputElement>('size').value = String(s.size);
    this.field<HTMLSelectElement>('snap').value = String(s.snap);
    this.field<HTMLInputElement>('upscale').checked = s.upscale;
    for (const r of this.dialog.querySelectorAll<HTMLInputElement>('[name="output"]')) r.checked = r.value === s.output;
    this.field<HTMLInputElement>('folder').value = s.folder ?? '';
  }

  private readForm(): void {
    const size = Number(this.field<HTMLInputElement>('size').value);
    this.state = {
      mode: this.field<HTMLSelectElement>('mode').value as ResizeMode,
      bucketBase: Number(this.field<HTMLSelectElement>('bucketBase').value),
      size: Number.isFinite(size) && size >= 64 ? Math.round(size) : this.state.size,
      snap: Number(this.field<HTMLSelectElement>('snap').value),
      upscale: this.field<HTMLInputElement>('upscale').checked,
      output: this.dialog.querySelector<HTMLInputElement>('[name="output"]:checked')?.value === 'folder' ? 'folder' : 'overwrite',
      folder: this.field<HTMLInputElement>('folder').value,
    };
    this.host.saveState(this.state);
    this.update();
  }

  private update(): void {
    const s = this.state;
    for (const el of this.dialog.querySelectorAll<HTMLElement>('[data-for]')) el.hidden = !el.dataset.for!.split(' ').includes(s.mode);
    const folderInput = this.field<HTMLInputElement>('folder');
    folderInput.disabled = s.output !== 'folder';
    this.$('.resize-output-hint').textContent =
      s.output === 'folder'
        ? 'Subfolders are mirrored; existing files there are replaced.'
        : this.host.editorBackup()
          ? 'The first overwrite of each image keeps the original as <name>.bak.'
          : 'Originals are replaced; no backup is kept (loraDataset.editorBackup).';

    const buckets = bucketsFor(s.bucketBase);
    this.plans = new Map();
    let change = 0;
    let same = 0;
    let skip = 0;
    let unknown = 0;
    const rows: HTMLElement[] = [];
    for (const id of this.ids) {
      const e = this.host.entry(id);
      const plan = e && e.w > 0 ? planResize(e.w, e.h, s, buckets) : undefined;
      this.plans.set(id, plan);
      if (!plan) unknown++;
      else if (plan.action === 'resize') change++;
      else if (plan.reason === 'unchanged') same++;
      else skip++;
      if (rows.length < MAX_ROWS && e) {
        const row = document.createElement('div');
        row.className = 'resize-row';
        row.dataset.id = id;
        row.setAttribute('role', 'option');
        row.classList.toggle('skip', plan?.action === 'skip');
        row.classList.toggle('on', id === this.previewId);
        const name = document.createElement('span');
        name.textContent = e.id;
        const sizes = document.createElement('span');
        sizes.textContent = plan ? `${e.w}×${e.h} → ${describe(plan)}` : 'size not known yet; decided when processing';
        row.append(name, sizes);
        rows.push(row);
      }
    }
    if (this.ids.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'hint';
      more.textContent = `… and ${this.ids.length - MAX_ROWS} more`;
      rows.push(more);
    }
    this.$('.resize-list').replaceChildren(...rows);
    const parts = [`${change} to change`, `${same} already fit`];
    if (skip) parts.push(`${skip} skipped`);
    if (unknown) parts.push(`${unknown} with unknown size`);
    this.$('.resize-summary').textContent = parts.join(' · ');
    (this.$('button[value="start"]') as HTMLButtonElement).disabled =
      change + unknown === 0 || (s.output === 'folder' && !s.folder?.trim());

    const first = this.previewId && this.plans.has(this.previewId) ? this.previewId : this.ids.find((id) => this.plans.get(id)?.action === 'resize');
    if (first) this.showPreview(first);
    else this.drawPreview(undefined);
  }

  private showPreview(id: string): void {
    this.previewId = id;
    for (const r of this.dialog.querySelectorAll<HTMLElement>('.resize-row')) r.classList.toggle('on', r.dataset.id === id);
    const e = this.host.entry(id);
    const url = e && this.host.previewUrl(e);
    if (!e || !url) {
      this.drawPreview(e);
      return;
    }
    if (this.previewImg?.dataset.id === id && this.previewImg.complete) {
      this.drawPreview(e);
      return;
    }
    const img = new Image();
    img.dataset.id = id;
    this.previewImg = img;
    img.onload = () => this.previewImg === img && this.drawPreview(e);
    img.onerror = () => this.previewImg === img && this.drawPreview(e);
    img.src = url;
    this.drawPreview(e);
  }

  /** Thumbnail with everything outside the crop dimmed. */
  private drawPreview(e: ImageEntry | undefined): void {
    const canvas = this.$('.resize-preview canvas') as HTMLCanvasElement;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const text = this.$('.resize-preview-text');
    const plan = e ? this.plans.get(e.id) : undefined;
    text.textContent = e ? `${e.id}${plan ? `: ${e.w}×${e.h} → ${describe(plan)}` : ''}` : '';
    const img = this.previewImg;
    if (!e || !e.w || !img || img.dataset.id !== e.id || !img.complete || !img.naturalWidth) return;
    const s = Math.min(canvas.width / e.w, canvas.height / e.h);
    const dw = e.w * s;
    const dh = e.h * s;
    const ox = (canvas.width - dw) / 2;
    const oy = (canvas.height - dh) / 2;
    g.drawImage(img, ox, oy, dw, dh);
    if (plan?.action !== 'resize' || !plan.cropped) return;
    const c = plan.crop;
    g.fillStyle = 'rgba(0, 0, 0, 0.6)';
    g.beginPath();
    g.rect(ox, oy, dw, dh);
    g.rect(ox + c.x * s, oy + c.y * s, c.w * s, c.h * s);
    g.fill('evenodd');
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.strokeRect(ox + c.x * s + 0.5, oy + c.y * s + 0.5, c.w * s - 1, c.h * s - 1);
  }
}
