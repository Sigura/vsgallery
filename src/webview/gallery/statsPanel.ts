import { kohyaBuckets } from '../../shared/buckets';
import { datasetStats, type CountRow } from '../../shared/datasetStats';
import { QUALITY_LABELS, type QualityFlag } from '../../shared/quality';
import type { ToolsContext } from './datasetTools';
import { flagsOf } from './qualityUi';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' })[c]};`);
const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : '–');

function bars(rows: readonly CountRow[], total: number): string {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return rows
    .map(
      (r) =>
        `<div class="stat-row"><span class="stat-label" title="${esc(r.label)}">${esc(r.label)}</span>` +
        `<span class="stat-bar"><span style="width:${(r.n / max) * 100}%"></span></span>` +
        `<span class="stat-n">${r.n}</span><span class="stat-pct">${pct(r.n, total)}</span></div>`,
    )
    .join('');
}

/** Read-only overview of the selected or visible images. */
export class StatsPanel {
  private readonly dialog: HTMLDialogElement;
  private base = 1024;

  constructor(
    private readonly ctx: ToolsContext,
    private readonly openBalance: () => void,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'leave-dialog tools-dialog';
    this.dialog.innerHTML = `
      <form>
        <div class="tools-head">
          <strong class="stats-title"></strong>
          <span class="spacer"></span>
          <label>Buckets
            <select name="base">
              <option value="512">SD 1.5 (512)</option>
              <option value="768">SD 2.x (768)</option>
              <option value="1024">SDXL (1024)</option>
            </select>
          </label>
          <button type="button" name="close">Close</button>
        </div>
        <div class="stats-body"></div>
      </form>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    this.dialog.querySelector('[name=close]')!.addEventListener('click', () => this.dialog.close());
    const base = this.dialog.querySelector<HTMLSelectElement>('[name=base]')!;
    this.dialog.querySelector('.stats-body')!.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('[name=balance]')) return;
      this.dialog.close();
      this.openBalance();
    });
    base.addEventListener('change', () => {
      this.base = Number(base.value);
      this.render();
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    this.dialog.querySelector<HTMLSelectElement>('[name=base]')!.value = String(this.base);
    this.render();
    this.dialog.showModal();
  }

  private render(): void {
    const { ids, what } = this.ctx.targets();
    const list = ids.map((id) => this.ctx.entry(id)!).filter(Boolean);
    const s = datasetStats(list, kohyaBuckets(this.base, 256, this.base * 2, 64));
    this.dialog.querySelector('.stats-title')!.textContent = `Statistics of ${what}`;
    const n = s.images;

    const folders = s.folders
      .map(
        (f) =>
          `<tr><td title="${esc(f.dir || '(root)')}">${esc(f.dir || '(root)')}</td><td>${f.hasRepeats ? f.repeats : '–'}</td>` +
          `<td>${f.images}</td><td>${f.samples}</td><td>${pct(f.samples, s.samplesPerEpoch)}</td></tr>`,
      )
      .join('');
    const noRepeats = s.folders.some((f) => !f.hasRepeats);

    const settings = this.ctx.settings();
    const flagCounts = new Map<QualityFlag, number>();
    let analysed = 0;
    for (const e of list) {
      if (e.metrics) analysed++;
      for (const f of flagsOf(e, settings)) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
    }
    const flagRows = (Object.keys(QUALITY_LABELS) as QualityFlag[]).map((f) => ({ label: QUALITY_LABELS[f], n: flagCounts.get(f) ?? 0 }));

    const c = s.captions;
    this.dialog.querySelector('.stats-body')!.innerHTML = `
      <section>
        <h4>Folders · ${n} images · ${s.samplesPerEpoch} samples per epoch</h4>
        <table class="stats-table">
          <thead><tr><th>Folder</th><th>Repeats</th><th>Images</th><th>Samples / epoch</th><th>Share</th></tr></thead>
          <tbody>${folders}</tbody>
        </table>
        <button type="button" name="balance">Balance repeats…</button>
        <p class="hint">Samples per epoch = images × kohya repeats (from "N_name" folder names)${noRepeats ? '; folders without a repeat prefix count once' : ''}. Steps per epoch = samples ÷ batch size.</p>
      </section>
      <section class="stats-grid">
        <div>
          <h4>Short side</h4>
          ${bars(s.resolution, n - s.unknownSize)}
          ${s.unknownSize ? `<p class="hint">${s.unknownSize} image(s) of unknown size</p>` : ''}
          <h4>Orientation</h4>
          ${bars(s.orientation, n - s.unknownSize)}
        </div>
        <div>
          <h4>Buckets (${this.base}², nearest aspect ratio)</h4>
          <div class="stats-scroll">${bars(s.buckets, n - s.unknownSize)}</div>
          <p class="hint">kohya assigns each image to the bucket with the closest aspect ratio; with bucket_no_upscale small images get their own smaller bucket.</p>
        </div>
      </section>
      <section class="stats-grid">
        <div>
          <h4>Captions</h4>
          ${bars(
            [
              { label: 'With text', n: c.withText },
              { label: 'No caption file', n: c.missing },
              { label: 'Empty', n: c.empty },
              ...(c.notLoaded ? [{ label: 'Not loaded yet', n: c.notLoaded }] : []),
            ],
            n,
          )}
          <p>${s.tags.unique} distinct tags · ${s.tags.total} in total · ${s.tags.perCaption.toFixed(1)} per caption</p>
          <h4>Quality flags</h4>
          ${bars(flagRows, n)}
          <p class="hint">Blur is known for ${analysed} of ${n} images${analysed < n ? ' (analysis runs in the background)' : ''}.</p>
        </div>
        <div>
          <h4>Most frequent tags</h4>
          <div class="stats-scroll tall">${bars(s.tags.top, c.withText)}</div>
        </div>
      </section>`;
  }
}
