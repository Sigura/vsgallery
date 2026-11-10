import { groupByHash } from '../../shared/imageHash';
import type { ImageEntry } from '../../shared/protocol';
import type { ToolsContext } from './datasetTools';
import { loadImage } from '../imageLoad';

const MAX_GROUPS = 200;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' })[c]};`);

function fileSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Best copy first: most pixels, then larger file, then name. */
function better(a: ImageEntry, b: ImageEntry): number {
  return b.w * b.h - a.w * a.h || b.size - a.size || a.id.localeCompare(b.id);
}

/**
 * Near-duplicate groups by perceptual hash among the selected or visible images. In each group
 * the largest image is kept and the others are marked for deletion; clicking toggles a mark.
 */
export class DuplicatesDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly q = <T extends HTMLElement>(sel: string) => this.dialog.querySelector(sel) as T;
  private ids: string[] = [];
  private groups: string[][] = [];
  private readonly marked = new Set<string>();
  /** Explicit keep (false) / delete (true) choices; other images default to "delete unless best of its group". */
  private readonly decisions = new Map<string, boolean>();
  private hash: 'phash' | 'dhash' = 'phash';
  private threshold = 6;
  /** Ids that were in a group the last time groups were computed (tile badge). */
  readonly inGroup = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private regroupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ctx: ToolsContext,
    private readonly groupsChanged: () => void,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'leave-dialog tools-dialog dup-dialog';
    this.dialog.innerHTML = `
      <form>
        <div class="tools-head">
          <strong class="dup-title"></strong>
          <span class="spacer"></span>
          <label title="pHash tolerates small edits and recompression better; dHash is stricter about structure">Hash
            <select name="hash"><option value="phash">pHash</option><option value="dhash">dHash</option></select>
          </label>
          <label title="Maximum number of differing bits (of 64) for two images to count as near-duplicates">Threshold
            <input name="threshold" type="range" min="0" max="20" step="1"> <span class="dup-th"></span>
          </label>
          <button type="button" name="close">Close</button>
        </div>
        <p class="hint dup-status"></p>
        <div class="dup-groups"></div>
        <div class="dialog-buttons">
          <span class="hint">Click an image to toggle keep / delete. Double-click opens it. Deleting is permanent.</span>
          <span class="spacer"></span>
          <button type="button" name="delete" class="danger">Delete marked</button>
        </div>
      </form>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    this.q('[name=close]').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.ctx.wantThumbs([]);
    });
    const hash = this.q('[name=hash]') as HTMLSelectElement;
    const th = this.q('[name=threshold]') as HTMLInputElement;
    hash.addEventListener('change', () => {
      this.hash = hash.value as 'phash' | 'dhash';
      this.regroup();
    });
    th.addEventListener('input', () => {
      this.threshold = Number(th.value);
      this.q('.dup-th').textContent = th.value;
      this.regroup();
    });
    const groupsEl = this.q('.dup-groups');
    groupsEl.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (!id) return;
      const del = !this.marked.has(id);
      this.decisions.set(id, del);
      if (del) this.marked.add(id);
      else this.marked.delete(id);
      this.render();
    });
    groupsEl.addEventListener('dblclick', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (!id) return;
      this.dialog.close();
      this.ctx.openDetail(id, this.groups.find((g) => g.includes(id)) ?? [id]);
    });
    this.q('[name=delete]').addEventListener('click', () => this.deleteMarked());
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    const { ids, what } = this.ctx.targets();
    this.ids = ids;
    this.q('.dup-title').textContent = `Near-duplicates among ${what}`;
    (this.q('[name=hash]') as HTMLSelectElement).value = this.hash;
    (this.q('[name=threshold]') as HTMLInputElement).value = String(this.threshold);
    this.q('.dup-th').textContent = String(this.threshold);
    this.decisions.clear();
    const analyzer = this.ctx.analyzer();
    this.unsubscribe?.();
    this.unsubscribe = analyzer?.onProgress(() => {
      this.regroupTimer ??= setTimeout(() => {
        this.regroupTimer = undefined;
        if (this.isOpen) this.regroup();
      }, 1000);
    });
    this.regroup();
    this.dialog.showModal();
  }

  /** Shows a thumbnail that was generated after the tile was rendered. */
  thumbChanged(id: string): void {
    if (!this.isOpen || !this.inGroup.has(id)) return;
    const img = this.q('.dup-groups').querySelector<HTMLImageElement>(`.dup-tile[data-id="${CSS.escape(id)}"] img`);
    if (img) this.showThumb(img, id);
  }

  private showThumb(img: HTMLImageElement, id: string): void {
    const e = this.ctx.entry(id);
    const url = e && this.ctx.previewUrl(e);
    if (e && url) loadImage(img, url, (failed) => this.ctx.thumbFailed(e, failed));
  }

  /** Entries removed elsewhere drop out of the groups. */
  entriesRemoved(): void {
    if (this.isOpen) this.regroup();
  }

  private regroup(): void {
    this.ids = this.ids.filter((id) => this.ctx.entry(id));
    const items: { id: string; hash: string }[] = [];
    for (const id of this.ids) {
      const m = this.ctx.entry(id)!.metrics;
      if (m) items.push({ id, hash: m[this.hash] });
    }
    const entry = (id: string) => this.ctx.entry(id)!;
    this.groups = groupByHash(items, this.threshold)
      .map((g) => g.map(entry).sort(better).map((e) => e.id))
      .sort((a, b) => b.length - a.length);
    this.marked.clear();
    for (const g of this.groups) g.forEach((id, i) => (this.decisions.get(id) ?? i > 0) && this.marked.add(id));
    this.inGroup.clear();
    for (const g of this.groups) for (const id of g) this.inGroup.add(id);
    this.groupsChanged();
    const pending = this.ids.length - items.length;
    const analyzer = this.ctx.analyzer();
    this.q('.dup-status').textContent =
      `${this.groups.length} group(s), ${this.inGroup.size} images.` +
      (pending ? ` ${pending} image(s) not analysed yet${analyzer?.pending ? ' (in progress…)' : ''}.` : '') +
      (analyzer?.failedCount ? ` ${analyzer.failedCount} could not be analysed.` : '');
    this.render();
  }

  private render(): void {
    const html = this.groups.slice(0, MAX_GROUPS).map((g, gi) => {
      const tiles = g
        .map((id) => {
          const e = this.ctx.entry(id)!;
          const del = this.marked.has(id);
          return (
            `<div class="dup-tile ${del ? 'del' : 'keep'}" data-id="${esc(id)}" title="${esc(id)}">` +
            `<div class="dup-img"><img alt="" draggable="false"><span class="dup-mark">${del ? 'delete' : 'keep'}</span></div>` +
            `<div class="dup-name">${esc(e.name)}</div>` +
            `<div class="dup-sub">${e.w ? `${e.w}×${e.h}` : '?'} · ${fileSize(e.size)}${e.dir ? ` · ${esc(e.dir)}` : ''}</div></div>`
          );
        })
        .join('');
      return `<div class="dup-group"><div class="dup-group-head">Group ${gi + 1} · ${g.length} images</div><div class="dup-row">${tiles}</div></div>`;
    });
    if (this.groups.length > MAX_GROUPS) html.push(`<p class="hint">… and ${this.groups.length - MAX_GROUPS} more groups</p>`);
    if (!this.groups.length) html.push('<p class="hint">No near-duplicates at this threshold.</p>');
    const scroll = this.q('.dup-groups').scrollTop;
    this.q('.dup-groups').innerHTML = html.join('');
    const shown: string[] = [];
    for (const img of this.q('.dup-groups').querySelectorAll<HTMLImageElement>('.dup-tile img')) {
      const id = img.closest<HTMLElement>('.dup-tile')!.dataset.id!;
      shown.push(id);
      this.showThumb(img, id);
    }
    this.ctx.wantThumbs(shown);
    this.q('.dup-groups').scrollTop = scroll;
    const del = this.q('[name=delete]') as HTMLButtonElement;
    del.textContent = `Delete marked (${this.marked.size})`;
    del.disabled = !this.marked.size;
  }

  private deleteMarked(): void {
    const ids = [...this.marked].filter((id) => this.ctx.entry(id));
    if (!ids.length) return;
    this.ctx.deleteIds(ids);
    const gone = new Set(ids);
    this.ids = this.ids.filter((id) => !gone.has(id));
    this.regroup();
  }
}
