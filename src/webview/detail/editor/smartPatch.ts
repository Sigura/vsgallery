import { contextRect } from '../../../shared/inpaint';
import { intersectRect } from '../../../shared/layerMath';
import type { EditDocument } from './document';
import type { PatchRequest, PatchResponse } from './patchWorker';
import type { Selection } from './selection';

/** Content-aware fill of the selection on the active layer, computed in a worker. */
export class SmartPatcher {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (r: PatchResponse) => void>();
  busy = false;

  constructor(private readonly workerUrl: string) {}

  /** Resolves with an error message, or undefined once the fill is applied (one undo step). */
  async fill(doc: EditDocument, sel: Selection): Promise<string | undefined> {
    const b = sel.bounds;
    if (!b) return 'Select the area to fill first';
    if (this.busy) return 'A fill is already running';
    doc.rasterizeAll();
    const layer = doc.active;
    const inter = intersectRect(b, { x: layer.x, y: layer.y, w: layer.w, h: layer.h });
    if (!inter) return 'The selection is outside the active layer';
    const surface = doc.surface(layer);
    const area = contextRect({ x: inter.x - layer.x, y: inter.y - layer.y, w: inter.w, h: inter.h }, surface.width, surface.height);
    const img = surface.ctx.getImageData(area.x, area.y, area.w, area.h);
    const hole = new Uint8Array(area.w * area.h);
    for (let y = 0; y < area.h; y++) {
      for (let x = 0; x < area.w; x++) hole[y * area.w + x] = sel.has(area.x + x + layer.x, area.y + y + layer.y) ? 1 : 0;
    }
    const mark = doc.historyMark();
    this.busy = true;
    let res: PatchResponse;
    try {
      res = await this.call({ id: this.nextId++, rgba: img.data, w: area.w, h: area.h, hole });
    } finally {
      this.busy = false;
    }
    if (!res.ok) return res.error;
    if (doc.historyMark() !== mark || doc.active !== layer) return 'The image changed while filling; the fill was not applied';
    const before = surface.snapshot(area);
    surface.ctx.putImageData(new ImageData(new Uint8ClampedArray(res.rgba), area.w, area.h), area.x, area.y);
    surface.commitRegion('Smart patch', area, before);
    return undefined;
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    // Webview resources are cross-origin for Worker(), so the worker is started from a blob: URL.
    const res = await fetch(this.workerUrl);
    if (!res.ok) throw new Error(`Cannot load the patch worker: HTTP ${res.status}`);
    const w = new Worker(URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' })));
    w.onmessage = (ev: MessageEvent<PatchResponse>) => {
      const resolve = this.pending.get(ev.data.id);
      this.pending.delete(ev.data.id);
      resolve?.(ev.data);
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      w.terminate();
      this.worker = undefined;
      for (const [id, resolve] of this.pending) resolve({ id, ok: false, error: `Patch worker crashed: ${ev.message}` });
      this.pending.clear();
    };
    this.worker = w;
    return w;
  }

  private async call(req: PatchRequest): Promise<PatchResponse> {
    const w = await this.ensureWorker();
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve);
      w.postMessage(req, [req.rgba.buffer, req.hole.buffer]);
    });
  }
}
