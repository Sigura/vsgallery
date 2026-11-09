import type { HostToWebview, ImageEntry, ResizeOutput, WebviewToHost } from '../../shared/protocol';
import { bucketsFor, planResize, type ResizeOptions } from '../../shared/resizePlan';
import { encodeCanvas, formatOf } from '../detail/editor/document';
import { fetchBlob } from '../tagger/taggerClient';

export interface ResizeProgress {
  done: number;
  total: number;
  written: number;
  skipped: number;
  failed: number;
}

export interface ResizeBatchHost {
  entry(id: string): ImageEntry | undefined;
  imageUrl(e: ImageEntry): string;
  post(m: WebviewToHost): void;
  quality(): number;
  progress(p: ResizeProgress): void;
  error(message: string): void;
}

type Written = Extract<HostToWebview, { type: 'resizeWritten' }>;

/** Resizes images one at a time; the plan is recomputed from the decoded size, which is authoritative. */
export class ResizeBatch {
  private cancelled = false;
  private nextRequest = 1;
  private readonly pending = new Map<number, (m: Written) => void>();
  readonly progress: ResizeProgress;

  constructor(
    private readonly ids: readonly string[],
    private readonly opts: ResizeOptions,
    private readonly output: ResizeOutput,
    private readonly host: ResizeBatchHost,
  ) {
    this.progress = { done: 0, total: ids.length, written: 0, skipped: 0, failed: 0 };
  }

  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  onHostMessage(m: Written): void {
    const resolve = this.pending.get(m.requestId);
    this.pending.delete(m.requestId);
    resolve?.(m);
  }

  async run(): Promise<ResizeProgress> {
    const buckets = bucketsFor(this.opts.bucketBase);
    const fetchFor = (id: string | undefined) => {
      const e = id ? this.host.entry(id) : undefined;
      if (!e) return undefined;
      const p = fetchBlob(this.host.imageUrl(e));
      p.catch(() => undefined);
      return p;
    };
    let next = fetchFor(this.ids[0]);
    for (let i = 0; i < this.ids.length && !this.cancelled; i++) {
      const id = this.ids[i];
      const blob = next;
      next = fetchFor(this.ids[i + 1]);
      try {
        const e = this.host.entry(id);
        if (!blob || !e) throw new Error('image no longer exists');
        const data = await this.process(await blob, e, buckets);
        if (data) {
          await this.write(id, data);
          this.progress.written++;
        } else this.progress.skipped++;
      } catch (err) {
        this.progress.failed++;
        this.host.error(`Resize failed for ${id}: ${err instanceof Error ? err.message : err}`);
      }
      this.progress.done++;
      this.host.progress(this.progress);
    }
    return this.progress;
  }

  private async process(blob: Blob, e: ImageEntry, buckets: ReturnType<typeof bucketsFor>): Promise<Uint8Array | undefined> {
    const src = await createImageBitmap(blob);
    try {
      const plan = planResize(src.width, src.height, this.opts, buckets);
      if (plan.action === 'skip') return undefined;
      const { crop, out } = plan;
      const scaled = await createImageBitmap(src, crop.x, crop.y, crop.w, crop.h, {
        resizeWidth: out.w,
        resizeHeight: out.h,
        resizeQuality: 'high',
      });
      const canvas = new OffscreenCanvas(out.w, out.h);
      canvas.getContext('2d')!.drawImage(scaled, 0, 0);
      scaled.close();
      return await encodeCanvas(canvas, formatOf(e.name), this.host.quality());
    } finally {
      src.close();
    }
  }

  private async write(id: string, data: Uint8Array): Promise<void> {
    const requestId = this.nextRequest++;
    const reply = await new Promise<Written>((resolve) => {
      this.pending.set(requestId, resolve);
      this.host.post({ type: 'writeResized', requestId, id, data, output: this.output });
    });
    if (reply.error) throw new Error(reply.error);
  }
}
