import type { EditDocument } from './document';

const THUMB = 36;

/** Floating layer list over the viewer; only shown when the image has two or more layers. */
export class LayersPanel {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly getDoc: () => EditDocument | undefined,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'layers-panel';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="layers-head">Layers</div>
      <div class="layers-list" role="listbox" aria-label="Layers"></div>
      <div class="layers-actions">
        <button data-act="up" title="Move layer up">▲</button>
        <button data-act="down" title="Move layer down">▼</button>
        <button data-act="merge" title="Merge into the layer below">Merge ↓</button>
        <button data-act="delete" title="Delete layer">✕</button>
      </div>`;
    this.list = this.el.querySelector('.layers-list')!;
    parent.appendChild(this.el);
    // Clicks here must not reach the viewer (painting) or steal its keyboard focus for long.
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.list.addEventListener('click', (e) => {
      const d = this.getDoc();
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>('[data-index]');
      if (!d || !row) return;
      const i = Number(row.dataset.index);
      if (target.closest('.layer-eye')) d.setVisible(i, !d.layers[i].visible);
      else d.setActive(i);
    });
    this.el.querySelector('.layers-actions')!.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      const d = this.getDoc();
      if (!d || !act) return;
      const i = d.activeIndex;
      if (act === 'up') d.reorderLayer(i, 1);
      else if (act === 'down') d.reorderLayer(i, -1);
      else if (act === 'merge') d.mergeDown(i);
      else if (act === 'delete') d.removeLayer(i);
    });
  }

  refresh(): void {
    const d = this.getDoc();
    this.el.hidden = !d || d.layers.length < 2;
    if (!d || this.el.hidden) {
      this.list.replaceChildren();
      return;
    }
    const rows: HTMLElement[] = [];
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === d.activeIndex));
      row.classList.toggle('on', i === d.activeIndex);
      row.classList.toggle('hidden-layer', !l.visible);
      const eye = document.createElement('button');
      eye.className = 'layer-eye';
      eye.textContent = l.visible ? '👁' : '–';
      eye.title = l.visible ? 'Hide layer' : 'Show layer';
      const thumb = document.createElement('canvas');
      thumb.width = THUMB;
      thumb.height = THUMB;
      const s = Math.min(THUMB / l.canvas.width, THUMB / l.canvas.height);
      const tw = l.canvas.width * s;
      const th = l.canvas.height * s;
      thumb.getContext('2d')!.drawImage(l.canvas, (THUMB - tw) / 2, (THUMB - th) / 2, tw, th);
      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = l.name;
      row.append(eye, thumb, name);
      rows.push(row);
    }
    this.list.replaceChildren(...rows);
    const btn = (act: string) => this.el.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
    btn('up').disabled = d.activeIndex >= d.layers.length - 1;
    btn('down').disabled = d.activeIndex <= 0;
    btn('merge').disabled = d.activeIndex <= 0;
  }
}
