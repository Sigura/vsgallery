import { parseTags, tagKey } from '../../shared/captions';

const DRAG_THRESHOLD = 4;

export interface TagChipsOptions {
  onChange(tags: string[]): void;
  suggest(query: string, exclude: ReadonlySet<string>): string[];
}

/**
 * Tags as chips: × or Delete removes, double-click edits, drag or Alt+←/→ reorders,
 * and the trailing input adds tags with autocomplete (Enter, comma or Tab).
 */
export class TagChips {
  private tags: string[] = [];
  private readonly list: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly menu: HTMLElement;
  private suggestions: string[] = [];
  private active = -1;
  private drag: { pointerId: number; from: number; x: number; y: number; moving: boolean; to: number } | undefined;

  constructor(
    root: HTMLElement,
    private readonly opts: TagChipsOptions,
  ) {
    root.classList.add('chips');
    this.list = document.createElement('div');
    this.list.className = 'chip-list';
    this.input = document.createElement('input');
    this.input.className = 'chip-input';
    this.input.placeholder = 'Add tag…';
    this.input.setAttribute('aria-label', 'Add tag');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.menu = document.createElement('div');
    this.menu.className = 'suggest';
    this.menu.setAttribute('role', 'listbox');
    this.menu.hidden = true;
    root.append(this.list, this.menu);
    this.input.addEventListener('input', () => this.updateSuggestions());
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.closeMenu(), 150));
    this.input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text.includes(',')) return;
      e.preventDefault();
      this.add(this.input.value + text);
    });
    this.menu.addEventListener('pointerdown', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!item) return;
      e.preventDefault();
      this.accept(Number(item.dataset.i));
    });
    this.list.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.list.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.list.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.list.addEventListener('pointercancel', () => this.endDrag());
    this.list.addEventListener('keydown', (e) => this.onChipKey(e));
    this.list.addEventListener('dblclick', (e) => {
      const i = this.chipIndex(e.target);
      if (i !== undefined) this.editChip(i);
    });
    this.render();
  }

  setTags(tags: string[]): void {
    this.tags = [...tags];
    this.render();
  }

  focusInput(): void {
    this.input.focus();
  }

  private commit(next: string[]): void {
    this.tags = next;
    this.render();
    this.opts.onChange([...this.tags]);
  }

  private add(text: string): void {
    const keys = new Set(this.tags.map(tagKey));
    const added: string[] = [];
    for (const t of parseTags(text)) {
      const k = tagKey(t);
      if (keys.has(k)) {
        this.flash(this.tags.findIndex((x) => tagKey(x) === k));
        continue;
      }
      keys.add(k);
      added.push(t);
    }
    this.input.value = '';
    this.closeMenu();
    if (added.length) this.commit([...this.tags, ...added]);
    this.input.focus();
  }

  private remove(i: number): void {
    this.commit(this.tags.filter((_, j) => j !== i));
  }

  private move(from: number, to: number): void {
    if (from === to || to < 0 || to >= this.tags.length) return;
    const next = [...this.tags];
    const [t] = next.splice(from, 1);
    next.splice(to, 0, t);
    this.commit(next);
  }

  private render(): void {
    const chips = this.tags.map((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.tabIndex = 0;
      chip.dataset.i = String(i);
      chip.setAttribute('role', 'listitem');
      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = t;
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.tabIndex = -1;
      x.title = 'Remove tag';
      x.textContent = '×';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        this.remove(i);
      });
      chip.append(label, x);
      return chip;
    });
    this.list.replaceChildren(...chips, this.input);
  }

  private chipIndex(target: EventTarget | null): number | undefined {
    const chip = (target as HTMLElement | null)?.closest<HTMLElement>('.chip');
    return chip ? Number(chip.dataset.i) : undefined;
  }

  private chipAt(i: number): HTMLElement | undefined {
    return this.list.querySelector<HTMLElement>(`.chip[data-i="${i}"]`) ?? undefined;
  }

  private flash(i: number): void {
    const chip = this.chipAt(i);
    if (!chip) return;
    chip.classList.remove('flash');
    void chip.offsetWidth;
    chip.classList.add('flash');
  }

  private editChip(i: number): void {
    const chip = this.chipAt(i);
    if (!chip) return;
    const editor = document.createElement('input');
    editor.className = 'chip-edit';
    editor.value = this.tags[i];
    chip.replaceChildren(editor);
    editor.focus();
    editor.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (!save) return this.render();
      const parts = parseTags(editor.value);
      const next = [...this.tags];
      next.splice(i, 1, ...parts);
      const seen = new Set<string>();
      this.commit(next.filter((t) => !seen.has(tagKey(t)) && seen.add(tagKey(t))));
    };
    editor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    editor.addEventListener('blur', () => finish(true));
  }

  private onChipKey(e: KeyboardEvent): void {
    if (e.target === this.input) return;
    const i = this.chipIndex(e.target);
    if (i === undefined) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      this.remove(i);
      (this.chipAt(Math.min(i, this.tags.length - 1)) ?? this.input).focus();
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      this.editChip(i);
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      const to = i + (e.key === 'ArrowLeft' ? -1 : 1);
      this.move(i, to);
      this.chipAt(Math.max(0, Math.min(this.tags.length - 1, to)))?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const to = i + (e.key === 'ArrowLeft' ? -1 : 1);
      (this.chipAt(to) ?? (to >= this.tags.length ? this.input : undefined))?.focus();
    }
  }

  private onInputKey(e: KeyboardEvent): void {
    // Keys typed into the tag input must not trigger the image view shortcuts.
    e.stopPropagation();
    const open = !this.menu.hidden && this.suggestions.length > 0;
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      this.setActive((this.active + 1) % this.suggestions.length);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      this.setActive((this.active - 1 + this.suggestions.length) % this.suggestions.length);
    } else if ((e.key === 'Enter' || e.key === 'Tab') && open && this.active >= 0) {
      e.preventDefault();
      this.accept(this.active);
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (this.input.value.trim()) this.add(this.input.value);
    } else if (e.key === 'Escape') {
      if (open) this.closeMenu();
      else this.input.blur();
    } else if (e.key === 'Backspace' && !this.input.value && this.tags.length) {
      e.preventDefault();
      this.chipAt(this.tags.length - 1)?.focus();
    }
  }

  private updateSuggestions(): void {
    const q = this.input.value;
    this.suggestions = this.opts.suggest(q, new Set(this.tags.map(tagKey)));
    this.active = this.suggestions.length ? 0 : -1;
    this.menu.replaceChildren(
      ...this.suggestions.map((s, i) => {
        const item = document.createElement('div');
        item.className = 'suggest-item';
        item.dataset.i = String(i);
        item.setAttribute('role', 'option');
        item.textContent = s;
        return item;
      }),
    );
    this.menu.hidden = this.suggestions.length === 0;
    this.setActive(this.active);
  }

  private setActive(i: number): void {
    this.active = i;
    this.menu.querySelectorAll('.suggest-item').forEach((el, j) => {
      el.classList.toggle('active', j === i);
      el.setAttribute('aria-selected', String(j === i));
      if (j === i) el.scrollIntoView({ block: 'nearest' });
    });
  }

  private accept(i: number): void {
    const s = this.suggestions[i];
    if (s !== undefined) this.add(s);
  }

  private closeMenu(): void {
    this.menu.hidden = true;
    this.suggestions = [];
    this.active = -1;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.chip-x, .chip-edit')) return;
    const from = this.chipIndex(e.target);
    if (from === undefined) return;
    this.drag = { pointerId: e.pointerId, from, x: e.clientX, y: e.clientY, moving: false, to: from };
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
      d.moving = true;
      this.list.setPointerCapture(e.pointerId);
      this.chipAt(d.from)?.classList.add('dragging');
    }
    d.to = this.dropIndex(e.clientX, e.clientY, d.from);
    this.list.querySelectorAll('.chip').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    const target = this.chipAt(d.to);
    if (target && d.to !== d.from) target.classList.add(d.to < d.from ? 'drop-before' : 'drop-after');
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    const { moving, from, to } = d;
    this.endDrag();
    if (moving) this.move(from, to);
  }

  private endDrag(): void {
    const d = this.drag;
    if (d && this.list.hasPointerCapture(d.pointerId)) this.list.releasePointerCapture(d.pointerId);
    this.drag = undefined;
    this.list.querySelectorAll('.chip').forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  }

  /** Index of the chip nearest to the pointer (chips wrap over several lines). */
  private dropIndex(x: number, y: number, fallback: number): number {
    let best = fallback;
    let bestDist = Infinity;
    this.list.querySelectorAll<HTMLElement>('.chip').forEach((el) => {
      const r = el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dist = dy * 4 + dx;
      if (dist < bestDist) {
        bestDist = dist;
        best = Number(el.dataset.i);
      }
    });
    return best;
  }
}
