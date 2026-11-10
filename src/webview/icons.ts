const PATHS: Record<string, string> = {
  sync: '<path d="M2.5 6.5a5.5 5.5 0 0 1 10-2.5"/><path d="M12.5 1.5v2.5H10"/><path d="M13.5 9.5a5.5 5.5 0 0 1-10 2.5"/><path d="M3.5 14.5V12H6"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M12.5 1.5v3h-3"/>',
  stats: '<path d="M2 13.5h12"/><path d="M4.5 11V7.5"/><path d="M8 11V3"/><path d="M11.5 11V5.5"/>',
  tags: '<path d="M2 2h5.5l6.5 6.5-5.5 5.5L2 7.5z"/><circle cx="5" cy="5" r="1"/>',
  duplicates: '<rect x="2" y="5" width="8" height="9" rx="1"/><path d="M5.5 2.5H13a1 1 0 0 1 1 1V11"/>',
  review: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  resize: '<path d="M9.5 2h4.5v4.5"/><path d="M14 2L9 7"/><path d="M6.5 14H2V9.5"/><path d="M2 14l5-5"/>',
  sparkle: '<path d="M7 1.5l1.4 4.1 4.1 1.4-4.1 1.4L7 12.5 5.6 8.4 1.5 7l4.1-1.4z"/><path d="M12.5 10.5v4M10.5 12.5h4"/>',
  trash: '<path d="M2 4.5h12"/><path d="M6 4.5v-2h4v2"/><path d="M3.5 4.5l.8 9.5h7.4l.8-9.5"/><path d="M6.5 7v4.5M9.5 7v4.5"/>',
  heal: '<rect x="1.8" y="5.2" width="12.4" height="5.6" rx="2.8" transform="rotate(-45 8 8)"/><path d="M6.6 6.6l2.8 2.8M8 6l2 2M6 8l2 2"/>',
  repeats: '<path d="M5.5 2l-1.5 12M11.5 2L10 14"/><path d="M2.5 5.5h11.5M2 10.5h11.5"/>',
  pan: '<path d="M8 1.5v13M1.5 8h13"/><path d="M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2"/>',
  brush: '<path d="M14 2L8 8"/><path d="M8 8c-2.2-.3-3.5 1-3.5 3 0 1.3-1 2.5-2.5 2.5 3.5.8 6.5-.8 6.5-3.5z"/>',
  eraser: '<path d="M9.5 2l4.5 4.5L7.5 13H4.5L2.4 10.9a1 1 0 0 1 0-1.4z"/><path d="M6 5.5l4.5 4.5"/><path d="M7.5 13.5H14"/>',
  wet: '<path d="M8 1.5S3.5 6.5 3.5 9.5a4.5 4.5 0 0 0 9 0C12.5 6.5 8 1.5 8 1.5z"/><path d="M6 10a2 2 0 0 0 2 2"/>',
  clone: '<path d="M6 1.5h4v3.5l-1 2.5H7L6 5z"/><path d="M2 9.5h12v2.5H2z"/><path d="M3 14.5h10"/>',
  picker: '<path d="M10.5 1.8l3.7 3.7-1.7 1.7-3.7-3.7z"/><path d="M9.6 4.8L3 11.4 2.2 14l2.6-.8 6.6-6.6"/>',
  crop: '<path d="M4.5 1v10.5H15"/><path d="M1 4.5h10.5V15"/>',
  move: '<rect x="1.5" y="1.5" width="8" height="8" stroke-dasharray="2 1.5"/><path d="M7.5 7.5l7 2.7-3 1.2-1.2 3z"/>',
  selRect: '<rect x="2" y="3" width="12" height="10" stroke-dasharray="2 1.6"/>',
  lasso: '<ellipse cx="8.5" cy="6.5" rx="6" ry="4" stroke-dasharray="2 1.6"/><path d="M5 10c-1.3 1.3-.8 3.5 1.2 3.5"/>',
  wand: '<path d="M2 14l8-8"/><path d="M11.5 1v3M10 2.5h3"/><path d="M13.5 6v2.5M12.25 7.25h2.5"/><path d="M7 1.5v2M6 2.5h2"/>',
  fill: '<path d="M3 9l5-5.5 5 5.5-5 5z"/><path d="M3 9h10"/><path d="M14.5 11.5s-1 1.3-1 2a1 1 0 0 0 2 0c0-.7-1-2-1-2z"/>',
  clear: '<rect x="2" y="2" width="12" height="12" stroke-dasharray="2 1.6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  invert: '<rect x="2" y="2" width="12" height="12"/><path d="M8 2v12" /><path d="M8 2h6v12H8z" fill="currentColor" stroke="none"/>',
  selAll: '<rect x="2" y="2" width="12" height="12" stroke-dasharray="2 1.6"/><rect x="5" y="5" width="6" height="6" fill="currentColor" stroke="none"/>',
  selNone: '<rect x="2" y="2" width="12" height="12" stroke-dasharray="2 1.6"/>',
  check: '<path d="M2.5 8.5l3.5 3.5 7.5-8"/>',
  close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  rotL: '<path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M4.5 1.5v3h-3"/>',
  rotR: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M11.5 1.5v3h3"/>',
  flipH: '<path d="M8 1v14" stroke-dasharray="1.5 1.5"/><path d="M6 4L2 12h4z"/><path d="M10 4l4 8h-4z"/>',
  flipV: '<path d="M1 8h14" stroke-dasharray="1.5 1.5"/><path d="M4 6L12 2v4z"/><path d="M4 10l8 4v-4z"/>',
  undo: '<path d="M5.5 3l-3.5 3.5 3.5 3.5"/><path d="M2 6.5h7.5a4 4 0 0 1 0 8H7"/>',
  redo: '<path d="M10.5 3l3.5 3.5-3.5 3.5"/><path d="M14 6.5H6.5a4 4 0 0 0 0 8H9"/>',
  compare: '<rect x="1.5" y="3" width="13" height="10" rx="1"/><path d="M8 1.5v13"/><path d="M8 3h5.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8z" fill="currentColor" stroke="none" opacity=".35"/>',
  save: '<path d="M2 2h9.5L14 4.5V14H2z"/><path d="M5 2v4h5V2"/><rect x="4.5" y="9" width="7" height="5"/>',
  saveCopy: '<path d="M4 4h8l2 2v8.5H4z"/><path d="M2 11.5V1.5h8.5"/><path d="M6.5 4v3h4V4"/>',
};

export function icon(name: string): string {
  const paths = PATHS[name];
  if (!paths) throw new Error(`Unknown icon: ${name}`);
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
}

/**
 * Puts the icon named by `data-icon` in front of each matching element's label. With
 * `data-icon-only` the label is replaced and kept as the accessible name.
 */
export function applyIcons(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (el.querySelector(':scope > svg.icon')) continue;
    const svg = icon(el.dataset.icon!);
    if (el.hasAttribute('data-icon-only')) {
      // Tooltips read "Name (shortcut) — details"; the name alone is the accessible label.
      const label = el.title.split(/ [(—]/)[0] || el.textContent!.trim();
      if (label && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', label);
      el.innerHTML = svg;
    } else {
      el.insertAdjacentHTML('afterbegin', svg);
    }
  }
}
