import { joinTags, mergeTags, parseTags } from '../../shared/captions';
import { combineCaption, type ExistingCaptionMode } from '../../shared/tagger';


export interface CaptionEditorHost {
  save(id: string, text: string): void;
  autosave(): { enabled: boolean; delay: number };
  generate(): void;
}

type SaveState = 'clean' | 'dirty' | 'saving' | 'error' | 'loading';

/**
 * Caption of one image as plain text: autosave or Ctrl+S, and reconciliation with
 * changes made to the caption file outside this editor.
 */
export class CaptionEditor {
  private id: string | undefined;
  /** Text of the file as last read or written by us. */
  private base = '';
  private text = '';
  private hasFile = false;
  private loading = false;
  private saving: string | undefined;
  private error: string | undefined;
  private conflict: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly textarea: HTMLTextAreaElement;
  private readonly stateEl: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly fileEl: HTMLElement;
  private readonly genButton: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  /** The user chose to write a caption for an image without a caption file. */
  private writing = false;

  constructor(
    root: HTMLElement,
    private readonly host: CaptionEditorHost,
  ) {
    root.innerHTML = `
      <div class="caption-head">
        <span class="caption-title">Caption</span>
        <span class="caption-file"></span>
        <span class="spacer"></span>
        <span class="save-state" aria-live="polite"></span>
        <button class="gen-btn" title="Generate tags with the WD tagger (G)">Generate</button>
        <button class="save-btn" title="Save caption (Ctrl+S)">Save</button>
      </div>
      <div class="caption-banner" hidden></div>
      <div class="caption-empty" hidden>
        <span>No caption file.</span>
        <button class="primary" data-empty="generate" title="Generate tags with the WD tagger (G)">Generate</button>
        <button data-empty="write" title="Start an empty caption (Enter)">Write caption</button>
      </div>
      <textarea class="caption-raw" spellcheck="false" aria-label="Caption text"></textarea>`;
    this.stateEl = root.querySelector('.save-state')!;
    this.banner = root.querySelector('.caption-banner')!;
    this.fileEl = root.querySelector('.caption-file')!;
    this.textarea = root.querySelector('.caption-raw')!;
    root.querySelector('.save-btn')!.addEventListener('click', () => this.saveNow());
    this.genButton = root.querySelector('.gen-btn')!;
    this.genButton.addEventListener('click', () => this.host.generate());
    this.emptyEl = root.querySelector('.caption-empty')!;
    this.emptyEl.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-empty]')?.dataset.empty;
      if (act === 'generate') this.host.generate();
      else if (act === 'write') this.focus();
    });
    this.textarea.addEventListener('input', () => this.edited(this.textarea.value));
    this.textarea.addEventListener('keydown', (e) => {
      // Arrow keys, Delete etc. belong to the text, not to image navigation.
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')) e.stopPropagation();
    });
    this.banner.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action) this.resolveConflict(action as 'reload' | 'merge' | 'keep');
    });
    this.applyEmpty();
  }

  get currentId(): string | undefined {
    return this.id;
  }

  get dirty(): boolean {
    return this.id !== undefined && this.text !== this.base;
  }

  /** `caption`: text, null = no caption file, undefined = not read yet. */
  load(id: string, caption: string | null | undefined, captionFile: string): void {
    clearTimeout(this.timer);
    this.id = id;
    this.saving = undefined;
    this.error = undefined;
    this.conflict = undefined;
    this.loading = caption === undefined;
    this.writing = false;
    this.hasFile = typeof caption === 'string';
    this.base = this.text = caption ?? '';
    this.fileEl.textContent = captionFile;
    this.renderText();
    this.renderState();
  }

  /** The caption file changed on disk (or was read for the first time). */
  external(id: string, caption: string | null): void {
    if (id !== this.id) return;
    const theirs = caption ?? '';
    this.hasFile = caption !== null;
    if (this.loading) {
      this.loading = false;
      this.base = this.text = theirs;
      this.renderText();
    } else if (theirs === this.text) {
      this.base = theirs;
      this.conflict = undefined;
    } else if (theirs === this.base || theirs === this.saving) {
      // Echo of our own save, or unchanged.
    } else if (!this.dirty) {
      this.base = this.text = theirs;
      this.renderText();
    } else {
      this.conflict = theirs;
    }
    this.renderState();
  }

  saved(id: string, text: string, error: string | undefined): void {
    if (id !== this.id || this.saving !== text) return;
    this.saving = undefined;
    this.error = error;
    if (!error) {
      this.base = text;
      this.hasFile = true;
      // Typing continued while the save was in flight.
      if (this.dirty) this.schedule();
    }
    this.renderState();
  }

  saveNow(): void {
    clearTimeout(this.timer);
    if (!this.id || !this.dirty || this.loading || this.conflict !== undefined) return;
    this.saving = this.text;
    this.error = undefined;
    this.host.save(this.id, this.text);
    this.renderState();
  }

  /** Called before leaving the image: autosave flushes; otherwise the caller must ask the user when this returns false. */
  flushForLeave(): boolean {
    if (!this.dirty) return true;
    if (this.host.autosave().enabled && this.conflict === undefined) {
      this.saveNow();
      return true;
    }
    return false;
  }

  /** Saves my version even if the file changed on disk meanwhile. */
  saveKeepingMine(): void {
    if (this.conflict !== undefined) {
      this.base = this.conflict;
      this.conflict = undefined;
    }
    this.saveNow();
  }

  discard(): void {
    this.text = this.base;
    this.conflict = undefined;
    this.renderText();
    this.renderState();
  }

  setGenerating(busy: boolean): void {
    for (const b of [this.genButton, this.emptyEl.querySelector<HTMLButtonElement>('[data-empty="generate"]')!]) {
      b.disabled = busy;
      b.textContent = busy ? 'Generating…' : 'Generate';
    }
  }

  /** Puts generated tags into the editor as an unsaved edit; 'skip' appends here, since the user asked for them. */
  applyGenerated(id: string, tags: readonly string[], mode: ExistingCaptionMode, triggerWord: string): boolean {
    if (id !== this.id || this.loading) return false;
    const text = combineCaption(this.text, tags, mode === 'skip' ? 'append' : mode, triggerWord);
    if (text === undefined || text === this.text) return true;
    this.edited(text);
    this.renderText();
    return true;
  }

  focus(): void {
    if (this.isEmpty()) {
      this.writing = true;
      this.applyEmpty();
    }
    this.textarea.focus();
  }

  /** No caption file and nothing typed or generated yet: show the Generate / Write placeholder instead of the editor. */
  private isEmpty(): boolean {
    return this.id !== undefined && !this.loading && !this.hasFile && !this.writing && this.text === '';
  }

  private applyEmpty(): void {
    const empty = this.isEmpty();
    this.emptyEl.hidden = !empty;
    this.textarea.hidden = empty;
  }

  private edited(text: string): void {
    if (!this.id || this.loading) return;
    this.text = text;
    this.error = undefined;
    this.schedule();
    this.renderState();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const { enabled, delay } = this.host.autosave();
    if (enabled) this.timer = setTimeout(() => this.saveNow(), delay);
  }

  private resolveConflict(action: 'reload' | 'merge' | 'keep'): void {
    const theirs = this.conflict;
    if (theirs === undefined) return;
    this.conflict = undefined;
    if (action === 'reload') {
      this.base = this.text = theirs;
    } else if (action === 'merge') {
      this.text = joinTags(mergeTags(parseTags(this.base), parseTags(this.text), parseTags(theirs)));
      this.base = theirs;
      this.schedule();
    } else {
      this.base = theirs;
      this.schedule();
    }
    this.renderText();
    this.renderState();
  }

  private renderText(): void {
    this.applyEmpty();
    if (this.textarea.value !== this.text) this.textarea.value = this.text;
    this.textarea.disabled = this.loading;
  }

  private renderState(): void {
    this.applyEmpty();
    let state: SaveState = 'clean';
    if (this.loading) state = 'loading';
    else if (this.error) state = 'error';
    else if (this.saving !== undefined) state = 'saving';
    else if (this.dirty) state = 'dirty';
    const labels: Record<SaveState, string> = {
      clean: this.hasFile ? 'Saved' : 'No caption file',
      dirty: '● Unsaved',
      saving: 'Saving…',
      error: `Save failed: ${this.error}`,
      loading: 'Loading…',
    };
    this.stateEl.textContent = labels[state];
    this.stateEl.dataset.state = state;
    this.banner.hidden = this.conflict === undefined;
    if (this.conflict !== undefined) {
      this.banner.innerHTML =
        '<span>The caption file changed on disk while you were editing.</span>' +
        '<button data-action="merge" title="Apply your tag additions/removals on top of the file">Merge</button>' +
        '<button data-action="reload" title="Discard your changes">Reload</button>' +
        '<button data-action="keep" title="Overwrite the file with your version">Keep mine</button>';
    }
  }
}
