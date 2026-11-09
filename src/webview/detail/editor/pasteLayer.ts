import { isTyping } from '../imageViewer';

function imageFile(items: DataTransferItemList | undefined, files: FileList | undefined): File | undefined {
  for (const item of items ?? []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  for (const f of files ?? []) if (f.type.startsWith('image/')) return f;
  return undefined;
}

/**
 * Ctrl+V of a clipboard image and image files dropped onto `target` call `add`.
 * `enabled` gates both (editor has an image and is visible).
 */
export function installPasteAndDrop(target: HTMLElement, enabled: () => boolean, add: (image: Blob, name: string) => void): void {
  window.addEventListener('paste', (e) => {
    if (!enabled() || isTyping(e.target)) return;
    const f = imageFile(e.clipboardData?.items, e.clipboardData?.files);
    if (!f) return;
    e.preventDefault();
    add(f, 'Pasted image');
  });
  target.addEventListener('dragover', (e) => {
    if (!enabled() || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('drop', (e) => {
    if (!enabled()) return;
    const f = imageFile(e.dataTransfer?.items, e.dataTransfer?.files);
    if (!f) return;
    e.preventDefault();
    add(f, f.name || 'Dropped image');
  });
}
