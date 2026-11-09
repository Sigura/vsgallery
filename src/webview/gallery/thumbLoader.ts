import { CancelledError, TaskQueue } from '../../shared/taskQueue';
import { withRetry } from '../../shared/retry';
import type { ImageEntry, WebviewToHost } from '../../shared/protocol';
import type { ThumbRequest, ThumbResponse } from './thumbWorker';

const MAX_OBJECT_URLS = 600;
const WORKER_TIMEOUT_MS = 60_000;

/** Transient failure: worth retrying the same job. */
class TransientError extends Error {}

/** The file is gone (deleted/renamed after the scan); retrying cannot help until the next scan. */
class NotFoundError extends Error {}

function isAbort(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof DOMException && e.name === 'AbortError');
}

/** Fetches originals and turns them into thumbnails in a worker, at most `concurrency` at a time. */
export class ThumbLoader {
  private readonly queue: TaskQueue;
  private worker!: Worker;
  private readonly rpc = new Map<number, { resolve: (r: ThumbResponse) => void; reject: (e: unknown) => void }>();
  private nextId = 1;
  /** Freshly generated thumbnails (object URLs), shown before/without the disk cache. */
  private readonly urls = new Map<string, string>();
  private readonly failed = new Map<string, string>();

  static async create(
    workerUrl: string,
    concurrency: number,
    resolution: number,
    post: (m: WebviewToHost) => void,
    onChange: (id: string) => void,
  ): Promise<ThumbLoader> {
    // Webview resources are cross-origin for Worker(), so the worker is started from a blob: URL.
    const res = await fetch(workerUrl);
    if (!res.ok) throw new Error(`Cannot load thumbnail worker: HTTP ${res.status}`);
    const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    return new ThumbLoader(blobUrl, concurrency, resolution, post, onChange);
  }

  private constructor(
    private readonly workerBlobUrl: string,
    concurrency: number,
    public resolution: number,
    private readonly post: (m: WebviewToHost) => void,
    private readonly onChange: (id: string) => void,
  ) {
    this.queue = new TaskQueue(concurrency);
    this.startWorker();
  }

  get busy(): number {
    return this.queue.pendingCount + this.queue.runningCount;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  objectUrl(key: string): string | undefined {
    return this.urls.get(key);
  }

  failure(key: string): string | undefined {
    return this.failed.get(key);
  }

  setConcurrency(n: number): void {
    this.queue.setConcurrency(n);
  }

  /** Lets previously failed thumbnails be attempted again (e.g. on Refresh). */
  resetFailures(): void {
    this.failed.clear();
  }

  request(entry: ImageEntry, imageUrl: string, priority: number): void {
    const key = entry.thumb;
    if (this.urls.has(key) || this.failed.has(key)) return;
    this.queue
      .add(key, priority, (signal) =>
        withRetry(() => this.generate(entry, imageUrl, signal), {
          retries: 10,
          baseDelayMs: 250,
          maxDelayMs: 4000,
          signal,
          isRetryable: (e) => e instanceof TransientError,
        }),
      )
      .then(() => this.onChange(entry.id))
      .catch((e: unknown) => {
        if (isAbort(e)) return;
        const reason = e instanceof NotFoundError ? 'missing' : 'unreadable';
        this.failed.set(key, reason);
        this.post({ type: 'error', message: `Thumbnail failed for ${entry.id}: ${e instanceof Error ? e.message : e}` });
        this.onChange(entry.id);
      });
  }

  /** Cancels queued (not running) jobs whose thumbnail key is not in `keys`. */
  retain(keys: ReadonlySet<string>): void {
    this.queue.retainOnly(keys);
  }

  private startWorker(): void {
    this.worker = new Worker(this.workerBlobUrl);
    this.worker.onmessage = (ev: MessageEvent<ThumbResponse>) => {
      const p = this.rpc.get(ev.data.id);
      this.rpc.delete(ev.data.id);
      p?.resolve(ev.data);
    };
    this.worker.onerror = (ev) => {
      ev.preventDefault();
      this.restartWorker(`Thumbnail worker crashed: ${ev.message}`);
    };
  }

  /**
   * In-flight requests fail as transient so they are retried on the fresh worker,
   * except `culprit` (the request that hung), which fails permanently.
   */
  private restartWorker(reason: string, culprit?: number): void {
    this.post({ type: 'error', message: reason });
    this.worker.terminate();
    const pending = [...this.rpc];
    this.rpc.clear();
    this.startWorker();
    for (const [id, p] of pending) p.reject(id === culprit ? new Error(reason) : new TransientError(reason));
  }

  private callWorker(req: ThumbRequest): Promise<ThumbResponse> {
    return new Promise<ThumbResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.rpc.has(req.id)) this.restartWorker(`Thumbnail worker timed out after ${WORKER_TIMEOUT_MS / 1000}s`, req.id);
      }, WORKER_TIMEOUT_MS);
      this.rpc.set(req.id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.worker.postMessage(req);
    });
  }

  private async fetchImage(url: string, signal: AbortSignal): Promise<Blob> {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (isAbort(e)) throw e;
      // fetch() rejects with TypeError on network-level failures (e.g. file locked while being written).
      throw new TransientError(`Fetch failed: ${e instanceof Error ? e.message : e}`);
    }
    if (res.status === 404) throw new NotFoundError('File not found');
    if (res.status === 408 || res.status === 429 || res.status >= 500) throw new TransientError(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try {
      return await res.blob();
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new TransientError(`Read failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async generate(entry: ImageEntry, imageUrl: string, signal: AbortSignal): Promise<void> {
    const blob = await this.fetchImage(imageUrl, signal);
    if (signal.aborted) throw new CancelledError();
    const out = await this.callWorker({ id: this.nextId++, blob, maxSide: this.resolution, w: entry.w, h: entry.h });
    // A decode error is permanent for this exact file version; an edited file gets a new key after rescan.
    if (!out.ok) throw new Error(out.error);
    const data = new Uint8Array(out.data);
    this.remember(entry.thumb, URL.createObjectURL(new Blob([data], { type: 'image/webp' })));
    this.post({ type: 'thumbData', id: entry.id, key: entry.thumb, data, w: out.w, h: out.h });
  }

  private remember(key: string, url: string): void {
    this.urls.set(key, url);
    if (this.urls.size <= MAX_OBJECT_URLS) return;
    const oldest = this.urls.keys().next().value as string;
    URL.revokeObjectURL(this.urls.get(oldest)!);
    this.urls.delete(oldest);
  }
}
