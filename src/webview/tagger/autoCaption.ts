import { isCaptionEmpty } from '../../shared/captions';
import type { ImageEntry } from '../../shared/protocol';
import type { ExistingCaptionMode } from '../../shared/tagger';
import { fetchBlob, type TaggerClient } from './taggerClient';

/** Consecutive failures after which the batch stops: the model or worker is broken, not one image. */
const MAX_CONSECUTIVE_FAILURES = 5;

export interface BatchProgress {
  done: number;
  total: number;
  written: number;
  skipped: number;
  failed: number;
}

export interface BatchHost {
  entry(id: string): ImageEntry | undefined;
  imageUrl(e: ImageEntry): string;
  /** The host wrote a caption; keeps the gallery's copy current without waiting for the watcher. */
  captionWritten(id: string, text: string): void;
  progress(p: BatchProgress): void;
  error(message: string): void;
}

/** Captions images one by one; the next image is fetched while the current one is tagged. */
export class AutoCaptionBatch {
  private cancelled = false;
  readonly progress: BatchProgress;

  constructor(
    private readonly client: TaggerClient,
    private readonly ids: readonly string[],
    private readonly mode: ExistingCaptionMode,
    private readonly host: BatchHost,
  ) {
    this.progress = { done: 0, total: ids.length, written: 0, skipped: 0, failed: 0 };
  }

  /** Stops after the image being tagged now. */
  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  async run(): Promise<BatchProgress> {
    await this.client.prepare();
    const work = this.ids.filter((id) => !this.skipEarly(id));
    this.progress.skipped = this.ids.length - work.length;
    this.progress.done = this.progress.skipped;
    this.host.progress(this.progress);
    const fetchFor = (id: string | undefined) => {
      const e = id ? this.host.entry(id) : undefined;
      if (!e) return undefined;
      const p = fetchBlob(this.host.imageUrl(e));
      p.catch(() => undefined);
      return p;
    };
    let next = fetchFor(work[0]);
    let streak = 0;
    for (let i = 0; i < work.length && !this.cancelled; i++) {
      const id = work[i];
      const blob = next;
      next = fetchFor(work[i + 1]);
      try {
        if (!blob) throw new Error('image no longer exists');
        const tags = await this.client.tagBlob(await blob);
        const r = await this.client.applyCaption(id, tags, this.mode);
        if (r.error) throw new Error(r.error);
        if (r.skipped) this.progress.skipped++;
        else {
          this.progress.written++;
          if (r.text !== undefined) this.host.captionWritten(id, r.text);
        }
        streak = 0;
      } catch (e) {
        this.progress.failed++;
        const msg = e instanceof Error ? e.message : String(e);
        this.host.error(`Auto-caption failed for ${id}: ${msg}`);
        if (++streak >= MAX_CONSECUTIVE_FAILURES) throw new Error(`Stopped after ${streak} failures in a row: ${msg}`);
      }
      this.progress.done++;
      this.host.progress(this.progress);
    }
    return this.progress;
  }

  /** In skip mode, images whose caption is already known to be non-empty need no inference. */
  private skipEarly(id: string): boolean {
    if (this.mode !== 'skip') return false;
    const c = this.host.entry(id)?.caption;
    return typeof c === 'string' && !isCaptionEmpty(c);
  }
}
