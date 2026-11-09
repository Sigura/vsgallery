const SECTIONS: [title: string, rows: [keys: string, what: string][]][] = [
  [
    'Gallery',
    [
      ['Click · Ctrl+click · Shift+click', 'Select · toggle · select range'],
      ['Drag on empty space', 'Rubber-band selection'],
      ['Arrows · PgUp/PgDn · Home/End', 'Move focus (Shift extends the selection)'],
      ['Ctrl+A', 'Select all visible'],
      ['Ctrl+Space', 'Toggle the focused image'],
      ['Enter · double-click', 'Open in the detail view'],
      ['Esc', 'Clear the selection'],
      ['Delete', 'Delete selected images and their captions (permanent)'],
      ['Ctrl+wheel', 'Thumbnail size'],
      ['?', 'This help'],
    ],
  ],
  [
    'Review mode',
    [
      ['K', 'Keep, next image'],
      ['Delete · X', 'Delete image and caption (permanent), next image'],
      ['S · Space · →', 'Skip'],
      ['E · Enter', 'Edit the caption in the detail view (Esc there returns)'],
      ['← · Backspace', 'Previous image'],
      ['Esc', 'Exit review'],
    ],
  ],
  [
    'Detail view',
    [
      ['← · →', 'Previous / next image'],
      ['Esc', 'Back to the gallery'],
      ['F · 0 · 1', 'Fit · fit · 100%'],
      ['+ · −  · wheel', 'Zoom'],
      ['Space+drag · middle button', 'Pan with any tool'],
      ['G', 'Generate tags with the WD tagger'],
      ['Enter', 'Focus the caption editor'],
      ['Ctrl+S', 'Save caption and image edits'],
      ['Delete', 'Delete this image (permanent; not with a selection tool)'],
    ],
  ],
  [
    'Caption tags',
    [
      ['Enter · ,', 'Add the typed tag'],
      ['↑ · ↓ · Enter/Tab', 'Pick an autocomplete suggestion'],
      ['Backspace (empty input)', 'Remove the last tag'],
      ['← · → on a tag', 'Move focus between tags'],
      ['Alt+← · Alt+→', 'Move the focused tag'],
      ['Enter · F2 · double-click', 'Edit the focused tag'],
      ['Delete · Backspace on a tag', 'Remove it'],
    ],
  ],
  [
    'Image editor',
    [
      ['H', 'Pan'],
      ['B · E', 'Brush · eraser'],
      ['R', 'Wet paint (smudge)'],
      ['S', 'Clone stamp (Alt+click sets the source)'],
      ['I', 'Eyedropper (Alt+click with a brush)'],
      ['C', 'Crop (Enter applies, Esc cancels)'],
      ['V', 'Move layer (arrows nudge, Shift ×10)'],
      ['M · L · W', 'Rectangle · lasso · magic wand selection'],
      ['Shift / Alt while selecting', 'Add to / subtract from the selection'],
      ['Ctrl+A · Ctrl+D · Esc', 'Select all · deselect · deselect'],
      ['Ctrl+Shift+I', 'Invert the selection'],
      ['Delete', 'Clear the selected pixels'],
      ['[ · ]', 'Brush size'],
      ['Shift+click · Shift+Ctrl+click', 'Straight line · snapped to 15°'],
      ['Shift+drag', 'Resize the brush'],
      ['\\ (hold)', 'Show the original'],
      ['Ctrl+Z · Ctrl+Shift+Z · Ctrl+Y', 'Undo · redo · redo'],
      ['Ctrl+V · drop a file', 'Paste an image as a new layer'],
    ],
  ],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' })[c]};`);

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || !!t.closest('input, textarea, select'));
}

/** Keyboard reference, toggled with "?" anywhere outside text fields. */
export class HelpOverlay {
  private readonly dialog: HTMLDialogElement;

  constructor() {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'leave-dialog tools-dialog help-dialog';
    this.dialog.innerHTML = `
      <div class="tools-head"><strong>Keyboard shortcuts</strong><span class="spacer"></span><button type="button" name="close">Close</button></div>
      <div class="help-body">${SECTIONS.map(
        ([title, rows]) =>
          `<section><h4>${esc(title)}</h4><table>${rows
            .map(([k, w]) => `<tr><td class="help-keys">${esc(k)}</td><td>${esc(w)}</td></tr>`)
            .join('')}</table></section>`,
      ).join('')}</div>`;
    document.body.appendChild(this.dialog);
    this.dialog.querySelector('[name=close]')!.addEventListener('click', () => this.dialog.close());
    // Keys pressed inside the help must not reach the gallery, detail view or review behind it.
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === '?') {
        e.preventDefault();
        this.dialog.close();
      }
      e.stopPropagation();
    });
    // Capture phase: runs before the review mode's handler, which swallows every key.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || this.dialog.open) return;
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.open();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
  }
}
