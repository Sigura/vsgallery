import * as vscode from 'vscode';
import {
  DimsIndex,
  isHiddenPath,
  isImageName,
  readImageSize,
  relUri,
  scanFolder,
  splitRel,
  type ScanBatch,
  type ScannedFile,
} from './datasetScanner';
import { ThumbCache } from './thumbCache';
import { describeError, isNotFound, type SafeFs } from './safeFs';
import { CancelledError, TaskQueue } from '../shared/taskQueue';
import { decodeCaption } from '../shared/captions';
import type { EntryPatch, ImageEntry, ImageMetrics } from '../shared/protocol';

export interface DatasetOptions {
  resolution: number;
  captionExts: string[];
  concurrency: number;
}

export interface DatasetSink {
  delta(upserts: ImageEntry[], removed: string[]): void;
  patch(patches: EntryPatch[]): void;
  skipped(items: { path: string; reason: string }[]): void;
}

interface Rec {
  file: ScannedFile;
  caption?: ScannedFile;
}

function stemOf(rel: string): string {
  const dot = rel.lastIndexOf('.');
  return dot > rel.lastIndexOf('/') + 1 ? rel.slice(0, dot) : rel;
}

function sameStat(a: ScannedFile | undefined, b: ScannedFile | undefined): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.size === b.size && a.mtime === b.mtime;
}

/**
 * In-memory model of one dataset folder. Every structural update (full scan or path refresh)
 * is serialized and reported to the sink as a delta; sizes and captions arrive later as patches.
 */
export class Dataset {
  readonly entries = new Map<string, ImageEntry>();
  private readonly recs = new Map<string, Rec>();
  private readonly byStem = new Map<string, Set<string>>();
  private readonly headerQueue: TaskQueue;
  private readonly captionQueue = new TaskQueue(8);
  private readonly statQueue = new TaskQueue(16);
  private thumbKeys = new Set<string>();
  private pending = new Map<string, EntryPatch>();
  private pendingUpserts = new Map<string, ImageEntry>();
  private upsertTimer: ReturnType<typeof setTimeout> | undefined;
  private patchTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly root: vscode.Uri,
    private readonly fs: SafeFs,
    private readonly cache: ThumbCache,
    private readonly dims: DimsIndex,
    private readonly log: vscode.LogOutputChannel,
    private readonly sink: DatasetSink,
    private opts: DatasetOptions,
  ) {
    this.headerQueue = new TaskQueue(opts.concurrency);
  }

  /** Changing resolution or caption extensions needs a rescan; returns whether one is required. */
  setOptions(opts: DatasetOptions): boolean {
    const prev = this.opts;
    this.opts = opts;
    this.headerQueue.setConcurrency(opts.concurrency);
    return prev.resolution !== opts.resolution || prev.captionExts.join('|') !== opts.captionExts.join('|');
  }

  /** Full rescan, diffed against the current state. Throws if the dataset folder cannot be read. */
  scan(): Promise<void> {
    return this.serialize(async () => {
      this.thumbKeys = await this.cache.listKeys();
      await this.scanUnserialized();
      this.dims.retain(new Set(this.recs.keys()));
    });
  }

  /** Incremental update for changed relative paths (files or folders, existing or deleted). */
  refresh(paths: Iterable<string>): Promise<void> {
    const list = [...paths];
    return this.serialize(async () => {
      if (list.includes('')) {
        await this.scanUnserialized();
        return;
      }
      const images = new Set<string>();
      const other: string[] = [];
      for (const p of list) {
        if (isHiddenPath(p)) continue;
        if (isImageName(p)) {
          images.add(p);
          continue;
        }
        const stem = this.captionStem(p);
        if (stem !== undefined) {
          for (const id of this.byStem.get(stem) ?? []) images.add(id);
          continue;
        }
        other.push(p);
      }
      // Folders: a parent already in the list covers its children.
      other.sort((a, b) => a.length - b.length);
      const dirs: string[] = [];
      for (const p of other) if (!dirs.some((d) => p.startsWith(`${d}/`))) dirs.push(p);
      for (const d of dirs) await this.refreshFolder(d);
      await this.refreshImages(images);
    });
  }

  removeIds(ids: readonly string[]): void {
    const removed = ids.filter((id) => this.remove(id));
    if (removed.length) this.sink.delta([], removed);
  }

  markThumb(id: string, key: string): void {
    this.thumbKeys.add(key);
    const e = this.entries.get(id);
    if (e && e.thumb === key) e.hasThumb = true;
  }

  /** Stores analysis results computed for thumbnail `key`; ignored when the file has changed since. */
  setMetrics(id: string, key: string, metrics: ImageMetrics): void {
    const e = this.entries.get(id);
    if (!e || e.thumb !== key) return;
    e.metrics = metrics;
    this.dims.setMetrics(id, e.size, e.mtime, e.w, e.h, metrics);
  }

  setDims(id: string, w: number, h: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.w = w;
    e.h = h;
    this.dims.set(id, e.size, e.mtime, w, h);
    this.queuePatch({ id, w, h });
  }

  /**
   * Existing caption files of an image. They are kept while another image with the same
   * stem (different extension, one shared caption) is not being deleted as well.
   */
  async captionFiles(id: string, deleting: ReadonlySet<string>): Promise<string[]> {
    const stem = stemOf(id);
    const shared = [...(this.byStem.get(stem) ?? [])].some((o) => o !== id && !deleting.has(o));
    if (shared) return [];
    const found: string[] = [];
    await Promise.all(
      this.opts.captionExts.map(async (ext) => {
        const rel = stem + ext;
        try {
          const st = await this.fs.stat(relUri(this.root, rel));
          if (st.type & vscode.FileType.File) found.push(rel);
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }),
    );
    return found;
  }

  dispose(): void {
    this.disposed = true;
    this.headerQueue.clear();
    this.captionQueue.clear();
    this.statQueue.clear();
    if (this.patchTimer) clearTimeout(this.patchTimer);
    if (this.upsertTimer) clearTimeout(this.upsertTimer);
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private scanUnserialized(): Promise<void> {
    return this.scanScope(null);
  }

  /**
   * Streams entries to the sink folder by folder while the scan runs; entries of `scope`
   * (null = whole dataset) that the scan did not find are removed once it has completed.
   */
  private async scanScope(scope: string | null): Promise<void> {
    const seen = new Set<string>();
    const result = await scanFolder(
      this.root,
      this.fs,
      this.opts.captionExts,
      (batch) => this.applyBatch(batch, seen),
      scope ?? '',
    );
    const removed: string[] = [];
    for (const id of [...this.entries.keys()]) {
      const inScope = scope === null || id.startsWith(`${scope}/`);
      if (inScope && !seen.has(id) && this.remove(id)) removed.push(id);
    }
    this.flushUpserts();
    if (removed.length) this.sink.delta([], removed);
    if (result.skipped.length) this.sink.skipped(result.skipped);
  }

  private async refreshFolder(rel: string): Promise<void> {
    let isDir = false;
    try {
      isDir = ((await this.fs.stat(relUri(this.root, rel))).type & vscode.FileType.Directory) !== 0;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (!isDir) {
      // Deleted folder (or a deleted non-image file, which then matches nothing).
      const removed = [...this.entries.keys()].filter((id) => id.startsWith(`${rel}/`) && this.remove(id));
      if (removed.length) this.sink.delta([], removed);
      return;
    }
    await this.scanScope(rel);
  }

  private async refreshImages(ids: ReadonlySet<string>): Promise<void> {
    const upserts: ImageEntry[] = [];
    const removed: string[] = [];
    await Promise.all(
      [...ids].map((id) =>
        this.statQueue
          .add(id, 0, async () => {
            const uri = relUri(this.root, id);
            let st: vscode.FileStat;
            try {
              st = await this.fs.stat(uri);
            } catch (e) {
              if (!isNotFound(e)) throw e;
              if (this.remove(id)) removed.push(id);
              return;
            }
            if (!(st.type & vscode.FileType.File)) return;
            const caption = await this.findCaption(id);
            const { dir, name } = splitRel(id);
            const entry = this.build({ id, dir, name, uri, size: st.size, mtime: st.mtime }, caption);
            if (entry) upserts.push(entry);
          })
          .catch((e: unknown) => {
            if (!(e instanceof CancelledError)) this.log.warn(`Cannot refresh ${id}: ${describeError(e)}`);
          }),
      ),
    );
    if (upserts.length || removed.length) this.sink.delta(upserts, removed);
  }

  private captionStem(rel: string): string | undefined {
    const lower = rel.toLowerCase();
    const ext = this.opts.captionExts.find((e) => lower.endsWith(e.toLowerCase()) && rel.length > e.length);
    return ext === undefined ? undefined : rel.slice(0, -ext.length);
  }

  /** The caption file to write for an image: its existing caption, or <stem> + first caption extension. */
  async captionTarget(id: string): Promise<string> {
    return (await this.findCaption(id))?.id ?? stemOf(id) + (this.opts.captionExts[0] ?? '.txt');
  }

  private async findCaption(id: string): Promise<ScannedFile | undefined> {
    const stem = stemOf(id);
    for (const ext of this.opts.captionExts) {
      const rel = stem + ext;
      const uri = relUri(this.root, rel);
      try {
        const st = await this.fs.stat(uri);
        if (st.type & vscode.FileType.File) return { id: rel, ...splitRel(rel), uri, size: st.size, mtime: st.mtime };
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    return undefined;
  }

  private applyBatch({ files, captions }: ScanBatch, seen: Set<string>): void {
    const capByKey = new Map<string, ScannedFile>();
    const exts = this.opts.captionExts.map((e) => e.toLowerCase());
    for (const c of captions) {
      const lower = c.id.toLowerCase();
      const ext = exts.find((e) => lower.endsWith(e));
      if (ext) capByKey.set(`${c.id.slice(0, -ext.length)}|${ext}`, c);
    }
    for (const f of files) {
      seen.add(f.id);
      const stem = stemOf(f.id);
      let caption: ScannedFile | undefined;
      for (const e of exts) if ((caption = capByKey.get(`${stem}|${e}`))) break;
      const entry = this.build(f, caption);
      if (entry) this.pendingUpserts.set(entry.id, entry);
    }
    this.upsertTimer ??= setTimeout(() => this.flushUpserts(), 250);
  }

  private flushUpserts(): void {
    if (this.upsertTimer) clearTimeout(this.upsertTimer);
    this.upsertTimer = undefined;
    const upserts = [...this.pendingUpserts.values()];
    this.pendingUpserts = new Map();
    if (upserts.length && !this.disposed) this.sink.delta(upserts, []);
  }

  /** Creates or updates the entry; returns it only when something visible changed. */
  private build(file: ScannedFile, caption: ScannedFile | undefined): ImageEntry | undefined {
    const thumb = ThumbCache.key(file.uri, file.size, file.mtime, this.opts.resolution);
    const prev = this.entries.get(file.id);
    const prevRec = this.recs.get(file.id);
    const sameFile = prev !== undefined && prev.size === file.size && prev.mtime === file.mtime;
    const sameCaption = prevRec !== undefined && sameStat(prevRec.caption, caption);
    if (prev && sameFile && sameCaption && prev.thumb === thumb) return undefined;

    let w = 0;
    let h = 0;
    let needHeader = false;
    if (prev && sameFile) {
      w = prev.w;
      h = prev.h;
    } else {
      const known = this.dims.get(file.id, file.size, file.mtime);
      if (known) ({ w, h } = known);
      else needHeader = true;
    }
    const entry: ImageEntry = {
      id: file.id,
      dir: file.dir,
      name: file.name,
      size: file.size,
      mtime: file.mtime,
      w,
      h,
      thumb,
      hasThumb: this.thumbKeys.has(thumb),
    };
    const metrics = prev && sameFile ? prev.metrics : this.dims.getMetrics(file.id, file.size, file.mtime);
    if (metrics) entry.metrics = metrics;
    // A changed caption keeps showing its previous text until the new one has been read.
    const captionKnown = sameCaption && prev?.caption !== undefined;
    if (caption) entry.captionFile = caption.id;
    if (!caption) entry.caption = null;
    else if (prev?.caption !== undefined && prev.caption !== null) entry.caption = prev.caption;

    if (!prevRec) {
      const stem = stemOf(file.id);
      let set = this.byStem.get(stem);
      if (!set) this.byStem.set(stem, (set = new Set()));
      set.add(file.id);
    }
    this.recs.set(file.id, { file, caption });
    this.entries.set(file.id, entry);
    this.pending.delete(file.id);
    if (needHeader) this.readHeader(file);
    if (caption && !captionKnown) this.readCaption(file.id, caption);
    return entry;
  }

  private remove(id: string): boolean {
    if (!this.entries.delete(id)) return false;
    this.recs.delete(id);
    this.pending.delete(id);
    this.pendingUpserts.delete(id);
    const stem = stemOf(id);
    const set = this.byStem.get(stem);
    set?.delete(id);
    if (set?.size === 0) this.byStem.delete(stem);
    return true;
  }

  private readHeader(f: ScannedFile): void {
    // Keyed by version so a newer version of the file is never merged into a stale pending read.
    this.headerQueue
      .add(`${f.id}|${f.size}|${f.mtime}`, 0, (signal) => readImageSize(f.uri, f.size, this.fs, signal))
      .then((size) => {
        const rec = this.recs.get(f.id);
        if (this.disposed || !rec || !sameStat(rec.file, f)) return;
        if (size) this.setDims(f.id, size.w, size.h);
        else this.dims.set(f.id, f.size, f.mtime, 0, 0);
      })
      .catch((e: unknown) => {
        // Not stored in the index, so the next scan tries again.
        if (!(e instanceof CancelledError)) this.log.warn(`Cannot read header of ${f.id}: ${describeError(e)}`);
      });
  }

  private readCaption(imageId: string, cap: ScannedFile): void {
    this.captionQueue
      .add(`${imageId}|${cap.id}|${cap.size}|${cap.mtime}`, 0, () => this.fs.readFile(cap.uri))
      .then((bytes) => {
        const rec = this.recs.get(imageId);
        const entry = this.entries.get(imageId);
        if (this.disposed || !rec || !entry || !sameStat(rec.caption, cap)) return;
        entry.caption = decodeCaption(bytes);
        this.queuePatch({ id: imageId, caption: entry.caption });
      })
      .catch((e: unknown) => {
        if (e instanceof CancelledError) return;
        // A vanished caption is picked up by the watcher's delete event.
        if (!isNotFound(e)) this.log.warn(`Cannot read caption ${cap.id}: ${describeError(e)}`);
      });
  }

  private queuePatch(p: EntryPatch): void {
    this.pending.set(p.id, { ...this.pending.get(p.id), ...p });
    this.patchTimer ??= setTimeout(() => {
      this.patchTimer = undefined;
      // Patches for entries the webview has not received yet would be dropped there.
      this.flushUpserts();
      const patches = [...this.pending.values()];
      this.pending = new Map();
      if (patches.length && !this.disposed) this.sink.patch(patches);
    }, 200);
  }
}
