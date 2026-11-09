import { CancelledError, TaskQueue } from '../../shared/taskQueue';
import { withRetry } from '../../shared/retry';
import type { ImageEntry, ImageMetrics, WebviewToHost } from '../../shared/protocol';
import type { AnalysisRequest, AnalysisResponse } from './analysisWorker';

const CONCURRENCY = 2;
const POST_DELAY_MS = 1000;

export interface AnalyzerHost {
  entry(id: string): ImageEntry | undefined;
  /** Thumbnail URL when one exists (cheap), else undefined. */
  thumbUrl(e: ImageEntry): string | undefined;
  imageUrl(e: ImageEntry): string;
  post(m: WebviewToHost): void;
  /** Metrics of these entries were set. */
  analysed(ids: string[]): void;
}

class FetchError extends Error {}

/**
 * Computes perceptual hashes and the blur metric of every image in the background, from its
 * thumbnail when there is one, else from the original. Results are stored on the entries and sent
 * to the host, which persists them.
 */
export class Analyzer {
  private readonly queue = new TaskQueue(CONCURRENCY);
  private worker!: Worker;
  private readonly rpc = new Map<number, (r: AnalysisResponse) => void>();
  private nextId = 1;
  private readonly failed = new Set<string>();
  private outgoing: { id: string; key: string; metrics: ImageMetrics }[] = [];
  private done: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  static async create(workerUrl: string, host: AnalyzerHost): Promise<Analyzer> {
    // Webview resources are cross-origin for Worker(), so the worker is started from a blob: URL.
    const res = await fetch(workerUrl);
    if (!res.ok) throw new Error(`Cannot load analysis worker: HTTP ${res.status}`);
    return new Analyzer(URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' })), host);
  }

  private constructor(
    private readonly blobUrl: string,
    private readonly host: AnalyzerHost,
  ) {
    this.startWorker();
  }

  /** Images still waiting for analysis. */
  get pending(): number {
    return this.queue.pendingCount + this.queue.runningCount;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /** Called whenever the pending count changes. */
  onProgress(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  resetFailures(): void {
    this.failed.clear();
  }

  /** Queues every entry without metrics; images with a thumbnail go first. */
  enqueue(entries: Iterable<ImageEntry>): void {
    let i = 0;
    for (const e of entries) {
      i++;
      if (e.metrics || this.failed.has(e.thumb) || this.queue.has(e.thumb)) continue;
      const priority = (this.host.thumbUrl(e) ? 0 : 1_000_000) + i;
      const { id, thumb } = e;
      this.queue
        .add(thumb, priority, (signal) =>
          withRetry(() => this.analyze(id, thumb, signal), {
            retries: 10,
            baseDelayMs: 250,
            maxDelayMs: 4000,
            signal,
            isRetryable: (err) => err instanceof FetchError,
          }),
        )
        .catch((err: unknown) => {
          if (err instanceof CancelledError) return;
          this.failed.add(thumb);
          this.host.post({ type: 'error', message: `Analysis failed for ${id}: ${err instanceof Error ? err.message : err}` });
        })
        .finally(() => this.notify());
    }
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private async analyze(id: string, key: string, signal: AbortSignal): Promise<void> {
    const e = this.host.entry(id);
    if (!e || e.thumb !== key || e.metrics) return;
    const url = this.host.thumbUrl(e) ?? this.host.imageUrl(e);
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (signal.aborted) throw new CancelledError();
      throw new FetchError(`Fetch failed: ${err instanceof Error ? err.message : err}`);
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) throw new FetchError(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const r = await this.call({ id: this.nextId++, blob });
    if (!r.ok) throw new Error(r.error);
    const cur = this.host.entry(id);
    if (!cur || cur.thumb !== key) return;
    cur.metrics = r.metrics;
    this.outgoing.push({ id, key, metrics: r.metrics });
    this.done.push(id);
    this.flushTimer ??= setTimeout(() => this.flush(), POST_DELAY_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (this.outgoing.length) this.host.post({ type: 'metrics', items: this.outgoing });
    const done = this.done;
    this.outgoing = [];
    this.done = [];
    if (done.length) this.host.analysed(done);
  }

  private startWorker(): void {
    this.worker = new Worker(this.blobUrl);
    this.worker.onmessage = (ev: MessageEvent<AnalysisResponse>) => {
      const resolve = this.rpc.get(ev.data.id);
      this.rpc.delete(ev.data.id);
      resolve?.(ev.data);
    };
    this.worker.onerror = (ev) => {
      ev.preventDefault();
      this.host.post({ type: 'error', message: `Analysis worker crashed: ${ev.message}` });
      this.worker.terminate();
      const pending = [...this.rpc];
      this.rpc.clear();
      this.startWorker();
      for (const [id, resolve] of pending) resolve({ id, ok: false, error: 'Analysis worker crashed' });
    };
  }

  private call(req: AnalysisRequest): Promise<AnalysisResponse> {
    return new Promise((resolve) => {
      this.rpc.set(req.id, resolve);
      this.worker.postMessage(req);
    });
  }
}
