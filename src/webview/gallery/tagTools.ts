import { tagFrequency } from '../../shared/captions';
import type { HostToWebview, TagOpChange } from '../../shared/protocol';
import { validateTagOp, type TagOp } from '../../shared/tagOps';
import type { ToolsContext } from './datasetTools';

type OpKind = 'rename' | 'remove' | 'addStart' | 'addEnd' | 'first';
type TagOpResult = Extract<HostToWebview, { type: 'tagOpResult' }>;

const MAX_TAG_ROWS = 500;
const MAX_CHANGE_ROWS = 300;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' })[c]};`);

/**
 * Dataset-wide tag operations on the selected or visible images. Every change is previewed
 * (computed by the host from the files on disk) before it can be applied.
 */
export class TagTools {
  private readonly dialog: HTMLDialogElement;
  private readonly q = <T extends HTMLElement>(sel: string) => this.dialog.querySelector(sel) as T;
  private ids: string[] = [];
  private requestId = 0;
  /** The previewed operation; Apply is only possible for exactly this one. */
  private previewed: { op: TagOp; ids: string[]; count: number } | undefined;
  private busy = false;

  constructor(private readonly ctx: ToolsContext) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'leave-dialog tools-dialog';
    this.dialog.innerHTML = `
      <form>
        <div class="tools-head">
          <strong class="tags-title"></strong>
          <span class="spacer"></span>
          <button type="button" name="close">Close</button>
        </div>
        <div class="tags-body">
          <div class="tags-freq">
            <input type="search" name="filter" placeholder="Filter tags…" aria-label="Filter tags">
            <div class="tags-list" role="listbox" aria-label="Tags by frequency"></div>
            <p class="hint tags-count"></p>
          </div>
          <div class="tags-op">
            <label>Operation
              <select name="kind">
                <option value="rename">Rename / merge tag</option>
                <option value="remove">Remove tag</option>
                <option value="addStart">Add tag at the start</option>
                <option value="addEnd">Add tag at the end</option>
                <option value="first">Move trigger word first</option>
              </select>
            </label>
            <label><span class="tag-label">Tag</span> <input name="tag" type="text" spellcheck="false"></label>
            <label data-for="rename">New name <input name="to" type="text" spellcheck="false"></label>
            <p class="hint op-hint"></p>
            <div class="dialog-buttons left">
              <button type="button" name="preview">Preview</button>
              <button type="button" name="apply" class="primary" disabled>Apply</button>
            </div>
            <p class="op-summary"></p>
            <div class="tags-changes"></div>
          </div>
        </div>
      </form>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    this.dialog.querySelector('[name=close]')!.addEventListener('click', () => this.dialog.close());
    this.q('[name=filter]').addEventListener('input', () => this.renderFreq());
    this.q('.tags-list').addEventListener('click', (e) => {
      const tag = (e.target as HTMLElement).closest<HTMLElement>('[data-tag]')?.dataset.tag;
      if (tag === undefined) return;
      (this.q('[name=tag]') as HTMLInputElement).value = tag;
      this.formChanged();
    });
    this.dialog.querySelector('form')!.addEventListener('input', (e) => {
      const name = (e.target as HTMLElement).getAttribute('name');
      if (name === 'filter') return;
      const tag = this.q('[name=tag]') as HTMLInputElement;
      const trigger = this.ctx.settings().tagger.triggerWord.trim();
      if (name === 'kind' && (this.q('[name=kind]') as HTMLSelectElement).value === 'first' && !tag.value.trim()) tag.value = trigger;
      this.formChanged();
    });
    this.q('[name=preview]').addEventListener('click', () => this.run(true));
    this.q('[name=apply]').addEventListener('click', () => this.run(false));
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    const { ids, what } = this.ctx.targets();
    this.ids = ids;
    this.q('.tags-title').textContent = `Tags of ${what}`;
    this.renderFreq();
    this.formChanged();
    this.dialog.showModal();
  }

  /** Returns true when the message was a tag operation result for this dialog. */
  onHostMessage(m: HostToWebview): boolean {
    if (m.type !== 'tagOpResult') return false;
    if (m.requestId === this.requestId) this.showResult(m);
    return true;
  }

  private readOp(): TagOp {
    const kind = (this.q('[name=kind]') as HTMLSelectElement).value as OpKind;
    const tag = (this.q('[name=tag]') as HTMLInputElement).value;
    switch (kind) {
      case 'rename':
        return { kind: 'rename', from: tag, to: (this.q('[name=to]') as HTMLInputElement).value };
      case 'remove':
        return { kind: 'remove', tag };
      case 'addStart':
        return { kind: 'add', tag, at: 'start' };
      case 'addEnd':
        return { kind: 'add', tag, at: 'end' };
      case 'first':
        return { kind: 'first', tag };
    }
  }

  private formChanged(): void {
    const kind = (this.q('[name=kind]') as HTMLSelectElement).value as OpKind;
    this.q('[data-for=rename]').hidden = kind !== 'rename';
    this.q('.tag-label').textContent = kind === 'first' ? 'Trigger word' : 'Tag';
    this.q('.op-hint').textContent = {
      rename: 'Every occurrence is renamed; where the new name already exists the two are merged into one tag.',
      remove: 'Removes the tag (case-insensitive) from every caption that has it.',
      addStart: 'Adds the tag in front unless the caption already has it. Images without a caption file get one.',
      addEnd: 'Appends the tag unless the caption already has it. Images without a caption file get one.',
      first: 'Moves the tag to the front; captions without it get it inserted. Images without a caption file get one.',
    }[kind];
    this.previewed = undefined;
    const invalid = validateTagOp(this.readOp());
    (this.q('[name=preview]') as HTMLButtonElement).disabled = !!invalid || this.busy || !this.ids.length;
    (this.q('[name=apply]') as HTMLButtonElement).disabled = true;
    this.q('.op-summary').textContent = invalid && this.hasInput() ? invalid : '';
    this.q('.tags-changes').replaceChildren();
  }

  private hasInput(): boolean {
    return !!(this.q('[name=tag]') as HTMLInputElement).value.trim() || !!(this.q('[name=to]') as HTMLInputElement).value.trim();
  }

  private renderFreq(): void {
    const captions: string[] = [];
    for (const id of this.ids) {
      const c = this.ctx.entry(id)?.caption;
      if (typeof c === 'string') captions.push(c);
    }
    const freq = [...tagFrequency(captions)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const filter = (this.q('[name=filter]') as HTMLInputElement).value.trim().toLowerCase();
    const shown = filter ? freq.filter(([t]) => t.toLowerCase().includes(filter)) : freq;
    this.q('.tags-list').innerHTML = shown
      .slice(0, MAX_TAG_ROWS)
      .map(([t, n]) => `<div class="tags-row" data-tag="${esc(t)}"><span>${esc(t)}</span><span>${n}</span></div>`)
      .join('');
    this.q('.tags-count').textContent =
      `${shown.length} of ${freq.length} tags` + (shown.length > MAX_TAG_ROWS ? ` (first ${MAX_TAG_ROWS} shown)` : '');
  }

  private run(dryRun: boolean): void {
    const op = dryRun ? this.readOp() : this.previewed?.op;
    const ids = dryRun ? this.ids : this.previewed?.ids;
    if (!op || !ids || this.busy) return;
    this.busy = true;
    (this.q('[name=preview]') as HTMLButtonElement).disabled = true;
    (this.q('[name=apply]') as HTMLButtonElement).disabled = true;
    this.q('.op-summary').textContent = dryRun ? 'Reading caption files…' : 'Writing caption files…';
    if (dryRun) this.previewed = { op, ids, count: 0 };
    this.ctx.post({ type: 'tagOp', requestId: ++this.requestId, ids, op, dryRun });
  }

  private showResult(m: TagOpResult): void {
    this.busy = false;
    const opError = m.errors.find((e) => e.id === '');
    const errors = m.errors.filter((e) => e.id !== '');
    if (m.applied) {
      for (const c of m.changes) this.ctx.captionWritten(c.id, c.after);
      this.previewed = undefined;
      this.renderFreq();
    } else if (this.previewed) this.previewed.count = m.changes.length;
    const n = m.changes.length;
    const files = `${n} caption file${n === 1 ? '' : 's'}`;
    let summary = opError
      ? opError.error
      : m.applied
        ? `Changed ${files}.`
        : n
          ? `${files} will change (of ${this.previewed?.ids.length ?? 0} images). Review, then Apply.`
          : 'Nothing would change.';
    if (errors.length) summary += ` ${errors.length} failed (see Output › LoRA Dataset Studio).`;
    this.q('.op-summary').textContent = summary;
    (this.q('[name=preview]') as HTMLButtonElement).disabled = false;
    (this.q('[name=apply]') as HTMLButtonElement).disabled = m.applied || !n || !!opError;
    this.renderChanges(m.changes, errors);
  }

  private renderChanges(changes: TagOpChange[], errors: { id: string; error: string }[]): void {
    const rows = changes.slice(0, MAX_CHANGE_ROWS).map(
      (c) =>
        `<div class="change-row"><div class="change-id">${esc(c.id)}</div>` +
        `<div class="change-before">${c.before === null ? '<em>(no caption file)</em>' : esc(c.before) || '<em>(empty)</em>'}</div>` +
        `<div class="change-after">${esc(c.after) || '<em>(empty)</em>'}</div></div>`,
    );
    if (changes.length > MAX_CHANGE_ROWS) rows.push(`<p class="hint">… and ${changes.length - MAX_CHANGE_ROWS} more</p>`);
    for (const e of errors.slice(0, 50)) rows.push(`<div class="change-row error">${esc(e.id)}: ${esc(e.error)}</div>`);
    this.q('.tags-changes').innerHTML = rows.join('');
  }
}
