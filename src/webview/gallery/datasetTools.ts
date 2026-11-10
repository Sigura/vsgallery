import type { GallerySettings, HostToWebview, ImageEntry, WebviewToHost } from '../../shared/protocol';
import { Analyzer } from './analyzer';
import { DuplicatesDialog } from './duplicates';
import { KohyaBalance } from './kohyaBalance';
import { ReviewMode } from './reviewMode';
import { StatsPanel } from './statsPanel';
import { TagTools } from './tagTools';

export interface ToolsHost {
  entries(): Iterable<ImageEntry>;
  entry(id: string): ImageEntry | undefined;
  /** Name of the folder this gallery is opened on. */
  rootName(): string;
  /** Selected images, or all visible ones when nothing is selected, in gallery order. */
  targets(): { ids: string[]; what: string };
  /** Thumbnail URL if one is available without generating it. */
  previewUrl(e: ImageEntry): string | undefined;
  imageUrl(e: ImageEntry): string;
  settings(): GallerySettings;
  post(m: WebviewToHost): void;
  deleteIds(ids: string[]): void;
  openDetail(id: string, order: string[]): void;
  /** A tag operation rewrote this caption. */
  captionWritten(id: string, text: string): void;
  /** Analysis results arrived for these entries. */
  analysed(ids: string[]): void;
  /** Duplicate groups were recomputed (tile badges). */
  duplicatesChanged(): void;
  reviewClosed(lastId: string | undefined): void;
  /** Analysis progress changed (status bar). */
  progress(): void;
}

export interface ToolsContext extends ToolsHost {
  analyzer(): Analyzer | undefined;
}

/** Statistics, tag tools, duplicates, review mode and the background analysis behind them. */
export class DatasetTools {
  private analyzerInst: Analyzer | undefined;
  private readonly stats: StatsPanel;
  private readonly tags: TagTools;
  private readonly dups: DuplicatesDialog;
  private readonly review: ReviewMode;
  private readonly balance: KohyaBalance;

  constructor(private readonly host: ToolsHost) {
    const ctx: ToolsContext = { ...host, analyzer: () => this.analyzerInst };
    this.balance = new KohyaBalance(ctx);
    this.stats = new StatsPanel(ctx, () => this.balance.open());
    this.tags = new TagTools(ctx);
    this.dups = new DuplicatesDialog(ctx, () => host.duplicatesChanged());
    this.review = new ReviewMode(ctx);
  }

  /** Any of the dialogs or the review is open. */
  get isOpen(): boolean {
    return this.stats.isOpen || this.tags.isOpen || this.dups.isOpen || this.review.isOpen || this.balance.isOpen;
  }

  get reviewing(): boolean {
    return this.review.isOpen;
  }

  openStats(): void {
    if (!this.isOpen) this.stats.open();
  }

  openBalance(): void {
    if (!this.isOpen) this.balance.open();
  }

  openTags(): void {
    if (!this.isOpen) this.tags.open();
  }

  openDuplicates(): void {
    if (!this.isOpen) this.dups.open();
  }

  openReview(): void {
    if (!this.isOpen) this.review.open();
  }

  async start(workerUrl: string): Promise<void> {
    if (!this.analyzerInst) {
      this.analyzerInst = await Analyzer.create(workerUrl, {
        entry: (id) => this.host.entry(id),
        thumbUrl: (e) => this.host.previewUrl(e),
        imageUrl: (e) => this.host.imageUrl(e),
        post: (m) => this.host.post(m),
        analysed: (ids) => {
          this.host.analysed(ids);
          for (const id of ids) this.review.entryChanged(id);
        },
      });
      this.analyzerInst.onProgress(() => this.host.progress());
    }
    this.analyzerInst.enqueue(this.host.entries());
  }

  statusText(): string {
    const a = this.analyzerInst;
    if (!a) return '';
    const parts: string[] = [];
    if (a.pending) parts.push(`Analysing: ${a.pending} queued`);
    if (a.failedCount) parts.push(`${a.failedCount} could not be analysed`);
    return parts.join(' · ');
  }

  /** Lets failed analyses be attempted again (Refresh). */
  resetFailures(): void {
    this.analyzerInst?.resetFailures();
  }

  entriesChanged(upserts: readonly ImageEntry[], removed: readonly string[]): void {
    this.analyzerInst?.enqueue(upserts);
    if (removed.length) {
      this.dups.entriesRemoved();
      this.review.entriesRemoved();
    }
    for (const e of upserts) this.review.entryChanged(e.id);
  }

  entryChanged(id: string): void {
    this.review.entryChanged(id);
  }

  isDuplicate(id: string): boolean {
    return this.dups.inGroup.has(id);
  }

  /** The detail view closed; returns true when the review continues (it then owns the focus). */
  detailClosed(): boolean {
    if (!this.review.isOpen) return false;
    this.review.resume();
    return true;
  }

  onHostMessage(m: HostToWebview): boolean {
    return this.tags.onHostMessage(m) || this.balance.onHostMessage(m);
  }
}
