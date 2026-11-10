import { defaultRepeatTarget, isKohyaFolder, planRepeats, type RepeatPlanRow } from '../../shared/kohya';
import type { HostToWebview } from '../../shared/protocol';
import type { ToolsContext } from './datasetTools';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' })[c]};`);

/**
 * Recomputes kohya repeats ("N_name" folders) so every folder contributes about the same number
 * of samples per epoch, and renames the folders. Counts cover all images, not just visible ones.
 */
export class KohyaBalance {
  private readonly dialog: HTMLDialogElement;
  private readonly q = <T extends HTMLElement>(sel: string) => this.dialog.querySelector(sel) as T;
  private rows: RepeatPlanRow[] = [];
  private requestId = 0;
  private busy = false;

  constructor(private readonly ctx: ToolsContext) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'leave-dialog tools-dialog';
    this.dialog.innerHTML = `
      <form>
        <div class="tools-head">
          <strong>Balance kohya repeats</strong>
          <span class="spacer"></span>
          <label>Target samples per folder <input name="target" type="number" min="1" step="1"></label>
          <label title="Folders without a number are not trained by kohya; this gives them one"><input name="plain" type="checkbox" checked> Also number folders without "N_"</label>
          <button type="button" name="close">Close</button>
        </div>
        <div class="stats-body">
          <table class="stats-table">
            <thead><tr><th>Folder</th><th>Images</th><th>Repeats</th><th>Samples</th><th>New repeats</th><th>New samples</th><th>New name</th></tr></thead>
            <tbody></tbody>
          </table>
          <p class="hint">New repeats = round(target ÷ images), at least 1. Only subfolders that hold images are renamed (never the folder this gallery is opened on); cached sizes, analysis and thumbnails move with them.</p>
          <p class="balance-result"></p>
        </div>
        <div class="dialog-buttons left">
          <button type="button" name="apply" class="primary">Rename folders</button>
        </div>
      </form>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    this.q('[name=close]').addEventListener('click', () => this.dialog.close());
    this.q('[name=target]').addEventListener('input', () => this.render());
    this.q('[name=plain]').addEventListener('change', () => {
      this.q<HTMLInputElement>('[name=target]').value = String(defaultRepeatTarget(this.folders(), this.includePlain()));
      this.render();
    });
    this.q('[name=apply]').addEventListener('click', () => this.apply());
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    this.q<HTMLInputElement>('[name=target]').value = String(defaultRepeatTarget(this.folders(), this.includePlain()));
    this.q('.balance-result').textContent = '';
    this.render();
    this.dialog.showModal();
  }

  onHostMessage(m: HostToWebview): boolean {
    if (m.type !== 'foldersRenamed') return false;
    if (m.requestId !== this.requestId) return true;
    this.busy = false;
    const failed = m.results.filter((r) => r.error);
    const done = m.results.length - failed.length;
    this.q('.balance-result').innerHTML =
      `${done} folder(s) renamed.` + failed.map((r) => `<br>${esc(r.from)} → ${esc(r.to)}: ${esc(r.error!)}`).join('');
    this.render();
    return true;
  }

  private includePlain(): boolean {
    return this.q<HTMLInputElement>('[name=plain]').checked;
  }

  private folders(): { dir: string; images: number }[] {
    const counts = new Map<string, number>();
    for (const e of this.ctx.entries()) counts.set(e.dir, (counts.get(e.dir) ?? 0) + 1);
    return [...counts].map(([dir, images]) => ({ dir, images }));
  }

  private render(): void {
    const target = Math.round(Number(this.q<HTMLInputElement>('[name=target]').value));
    this.rows = target > 0 ? planRepeats(this.folders(), target, this.includePlain()) : [];
    this.q('tbody').innerHTML = this.rows.length
      ? this.rows
          .map((r) => {
            const changed = r.newDir !== r.dir;
            const name = r.conflict ? `<span class="balance-conflict">${esc(r.conflict)}</span>` : changed ? esc(r.newDir) : '–';
            return (
              `<tr><td title="${esc(r.dir)}">${esc(r.dir)}</td><td>${r.images}</td><td>${r.repeats ?? '–'}</td><td>${r.repeats === undefined ? '–' : r.images * r.repeats}</td>` +
              `<td>${r.newRepeats}</td><td>${r.images * r.newRepeats}</td><td>${name}</td></tr>`
            );
          })
          .join('')
      : `<tr><td colspan="7">${esc(this.emptyReason())}</td></tr>`;
    const renames = this.rows.filter((r) => r.newDir !== r.dir);
    const apply = this.q<HTMLButtonElement>('[name=apply]');
    apply.disabled = this.busy || !renames.length || renames.some((r) => r.conflict);
    apply.textContent = renames.length ? `Rename ${renames.length} folder(s)` : 'Nothing to rename';
  }

  private emptyReason(): string {
    const root = this.ctx.rootName();
    const hasSubfolders = this.folders().some((f) => f.dir);
    if (!hasSubfolders && isKohyaFolder(root))
      return `This gallery is opened on "${root}" itself, which has no subfolders with images. Open its parent folder to balance the repeats of "${root}" and its siblings.`;
    if (!hasSubfolders) return 'No subfolders with images. Repeats are set on subfolders of the folder this gallery is opened on.';
    return 'No "N_name" subfolders with images. Tick "Also number folders without N_" to give plain folders a repeat count.';
  }

  private apply(): void {
    const renames = this.rows.filter((r) => r.newDir !== r.dir && !r.conflict).map((r) => ({ from: r.dir, to: r.newDir }));
    if (!renames.length || this.busy) return;
    this.busy = true;
    this.q('.balance-result').textContent = 'Renaming…';
    this.render();
    this.ctx.post({ type: 'renameFolders', requestId: ++this.requestId, renames });
  }
}
