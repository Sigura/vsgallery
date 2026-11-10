import { QUALITY_LABELS } from '../../shared/quality';
import type { ToolsContext } from './datasetTools';
import { flagsOf } from './qualityUi';
import { loadImage } from '../imageLoad';

type Verdict = 'keep' | 'delete' | 'skip';

/**
 * Full-window pass over the selected or visible images: K keeps, Delete/X deletes (permanently,
 * without confirmation), S/Space skips, E edits the caption in the detail view, ← goes back.
 */
export class ReviewMode {
  private readonly root: HTMLElement;
  private readonly q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
  private ids: string[] = [];
  private index = 0;
  private readonly verdicts = new Map<string, Verdict>();
  /** Suspended while the detail view edits a caption. */
  private suspended = false;
  private readonly preload = new Image();
  private shownId: string | undefined;

  constructor(private readonly ctx: ToolsContext) {
    this.root = document.createElement('section');
    this.root.className = 'review';
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.innerHTML = `
      <div class="review-bar">
        <strong class="review-count"></strong>
        <span class="review-name"></span>
        <span class="review-flags"></span>
        <span class="spacer"></span>
        <span class="hint">K keep · Del/X delete · S/Space skip · E edit caption · ← back · Esc exit</span>
        <button name="keep" title="Keep (K)">Keep</button>
        <button name="delete" class="danger" title="Delete image and caption (Delete or X)">Delete</button>
        <button name="skip" title="Skip (S or Space)">Skip</button>
        <button name="edit" title="Edit caption (E)">Edit</button>
        <button name="exit" title="Exit review (Esc)">Exit</button>
      </div>
      <div class="review-main"><img alt="" draggable="false"></div>
      <div class="review-caption"></div>`;
    document.body.appendChild(this.root);
    for (const v of ['keep', 'delete', 'skip'] as const) this.q(`[name=${v}]`).addEventListener('click', () => this.decide(v));
    this.q('[name=edit]').addEventListener('click', () => this.edit());
    this.q('[name=exit]').addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  get isOpen(): boolean {
    return !this.root.hidden || this.suspended;
  }

  open(): void {
    const { ids } = this.ctx.targets();
    if (!ids.length) return;
    this.ids = ids;
    this.index = 0;
    this.verdicts.clear();
    this.suspended = false;
    this.root.hidden = false;
    this.root.focus();
    this.show();
  }

  close(): void {
    this.root.hidden = true;
    this.suspended = false;
    this.ctx.reviewClosed(this.ids[this.index]);
  }

  /** The detail view was closed; continue where the caption edit started. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.root.hidden = false;
    this.root.focus();
    this.show();
  }

  /** Entries removed elsewhere (or deleted here) leave the list. */
  entriesRemoved(): void {
    if (!this.isOpen) return;
    const current = this.ids[this.index];
    const before = this.ids.slice(0, this.index).filter((id) => this.ctx.entry(id)).length;
    this.ids = this.ids.filter((id) => this.ctx.entry(id));
    this.index = current && this.ctx.entry(current) ? this.ids.indexOf(current) : before;
    if (!this.suspended) this.show();
  }

  /** A caption or size changed: refresh the shown text and flags. */
  entryChanged(id: string): void {
    if (!this.root.hidden && this.ids[this.index] === id) this.show();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.root.hidden || document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select')) return;
    // While reviewing, no key reaches the gallery behind (Delete there would delete its selection).
    e.stopImmediatePropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k === 'k') this.decide('keep');
    else if (e.key === 'Delete' || k === 'x') this.decide('delete');
    else if (k === 's' || e.key === ' ' || e.key === 'ArrowRight') this.decide('skip');
    else if (k === 'e' || e.key === 'Enter') this.edit();
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') this.go(this.index - 1);
    else if (e.key === 'Escape') this.close();
    else handled = false;
    if (handled) e.preventDefault();
  }

  private decide(v: Verdict): void {
    const id = this.ids[this.index];
    if (!id) return;
    this.verdicts.set(id, v);
    if (v === 'delete') {
      this.ctx.deleteIds([id]);
      // The entry disappears with the host's delta; until then it is shown as done and skipped.
    }
    this.go(this.index + 1);
  }

  private edit(): void {
    const id = this.ids[this.index];
    if (!id || !this.ctx.entry(id)) return;
    this.suspended = true;
    this.root.hidden = true;
    this.ctx.openDetail(id, [id]);
  }

  /** Moves to `i`, passing over images deleted in the meantime in the direction of travel. */
  private go(i: number): void {
    const step = i < this.index ? -1 : 1;
    let j = Math.max(0, Math.min(this.ids.length, i));
    while (j >= 0 && j < this.ids.length && !this.ctx.entry(this.ids[j])) j += step;
    this.index = j < 0 ? this.index : j;
    this.show();
  }

  private show(): void {
    const total = this.ids.length;
    const counts = { keep: 0, delete: 0, skip: 0 };
    for (const v of this.verdicts.values()) counts[v]++;
    const summary = `kept ${counts.keep} · deleted ${counts.delete} · skipped ${counts.skip}`;
    const img = this.q('.review-main img') as HTMLImageElement;
    const id = this.ids[this.index];
    const e = id ? this.ctx.entry(id) : undefined;
    for (const b of ['keep', 'delete', 'skip', 'edit'] as const) (this.q(`[name=${b}]`) as HTMLButtonElement).disabled = !e;
    if (!e) {
      this.q('.review-count').textContent = `Done: ${total} images`;
      this.q('.review-name').textContent = summary;
      this.q('.review-flags').replaceChildren();
      this.q('.review-caption').textContent = 'End of the list. ← goes back, Esc exits.';
      img.removeAttribute('src');
      this.shownId = undefined;
      return;
    }
    this.q('.review-count').textContent = `${this.index + 1} / ${total}`;
    const v = this.verdicts.get(id);
    this.q('.review-name').textContent = `${e.id} · ${e.w ? `${e.w}×${e.h}` : '?'}${v ? ` · ${v}` : ''} · ${summary}`;
    const flags = this.q('.review-flags');
    flags.replaceChildren(
      ...flagsOf(e, this.ctx.settings())
        .filter((f) => f !== 'not64')
        .map((f) => {
          const b = document.createElement('span');
          b.className = 'badge warn';
          b.textContent = QUALITY_LABELS[f];
          return b;
        }),
    );
    const caption = this.q('.review-caption');
    caption.textContent = e.caption === null ? '(no caption file)' : e.caption === undefined ? '…' : e.caption.trim() || '(empty caption)';
    caption.classList.toggle('missing', !e.caption?.trim());
    const url = this.ctx.imageUrl(e);
    if (this.shownId !== id) {
      this.shownId = id;
      // Show the thumbnail at once and swap in the full image when it has loaded.
      const preview = this.ctx.previewUrl(e);
      loadImage(img, preview ?? url, (failed) => (failed === url ? undefined : url));
      if (preview) {
        const full = new Image();
        full.onload = () => {
          if (this.ids[this.index] === id) loadImage(img, url);
        };
        loadImage(full, url);
      }
    }
    const next = this.ids[this.index + 1] && this.ctx.entry(this.ids[this.index + 1]);
    if (next) this.preload.src = this.ctx.imageUrl(next);
  }
}
