import * as vscode from 'vscode';
import { open } from 'node:fs/promises';
import { parseImageSize, type ImageSize } from './imageHeader';
import { TaskQueue } from '../shared/taskQueue';
import type { ImageMetrics } from '../shared/protocol';
import { describeError, isNotFound, type SafeFs } from './safeFs';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export interface ScannedFile {
  id: string;
  dir: string;
  name: string;
  uri: vscode.Uri;
  size: number;
  mtime: number;
}

export interface ScanResult {
  files: ScannedFile[];
  /** Caption files (by `captionExts`), same shape as images. */
  captions: ScannedFile[];
  /** Relative paths (dirs or files) that could not be read even after retries. */
  skipped: { path: string; reason: string }[];
}

export function isHiddenPath(rel: string): boolean {
  return rel.split('/').some((s) => s.startsWith('.'));
}

export function relUri(root: vscode.Uri, rel: string): vscode.Uri {
  return rel ? vscode.Uri.joinPath(root, ...rel.split('/')) : root;
}

export function splitRel(rel: string): { dir: string; name: string } {
  const slash = rel.lastIndexOf('/');
  return { dir: slash < 0 ? '' : rel.slice(0, slash), name: rel.slice(slash + 1) };
}

/**
 * Recursive listing of images and caption files below `root/start`. Hidden and symlinked
 * directories are skipped. Failure to read the start folder throws; unreadable subfolders/files
 * are reported in `skipped`. Files deleted between listing and stat are left out (they no longer exist).
 */
export async function scanFolder(
  root: vscode.Uri,
  fs: SafeFs,
  captionExts: readonly string[],
  start = '',
): Promise<ScanResult> {
  const capExts = captionExts.map((e) => e.toLowerCase());
  const isCaption = (name: string) => capExts.some((e) => name.toLowerCase().endsWith(e) && name.length > e.length);
  const found: { id: string; dir: string; name: string; uri: vscode.Uri; caption: boolean }[] = [];
  const skipped: ScanResult['skipped'] = [];
  const walk = async (dirUri: vscode.Uri, rel: string): Promise<void> => {
    let items: [string, vscode.FileType][];
    try {
      items = await fs.readDirectory(dirUri);
    } catch (e) {
      if (rel === start) throw e;
      if (!isNotFound(e)) skipped.push({ path: rel, reason: describeError(e) });
      return;
    }
    const subdirs: Promise<void>[] = [];
    for (const [name, type] of items) {
      if (type & vscode.FileType.Directory) {
        if (type & vscode.FileType.SymbolicLink || name.startsWith('.')) continue;
        subdirs.push(walk(vscode.Uri.joinPath(dirUri, name), rel ? `${rel}/${name}` : name));
      } else if (type & vscode.FileType.File) {
        const image = isImageName(name);
        if (!image && !isCaption(name)) continue;
        found.push({ id: rel ? `${rel}/${name}` : name, dir: rel, name, uri: vscode.Uri.joinPath(dirUri, name), caption: !image });
      }
    }
    await Promise.all(subdirs);
  };
  await walk(relUri(root, start), start);

  const q = new TaskQueue(16);
  const stated = await Promise.all(
    found.map((f) =>
      q.add(f.id, 0, async (): Promise<(ScannedFile & { caption: boolean }) | undefined> => {
        try {
          const st = await fs.stat(f.uri);
          return { ...f, size: st.size, mtime: st.mtime };
        } catch (e) {
          if (!isNotFound(e)) skipped.push({ path: f.id, reason: describeError(e) });
          return undefined;
        }
      }),
    ),
  );
  const files: ScannedFile[] = [];
  const captions: ScannedFile[] = [];
  for (const f of stated) {
    if (!f) continue;
    const { caption, ...file } = f;
    (caption ? captions : files).push(file);
  }
  return { files, captions, skipped };
}

/**
 * Partial reads are not available through vscode.workspace.fs, so local files are read
 * with node:fs in growing chunks; other schemes fall back to reading the whole file.
 * Returns null for data that is not a readable image header (also: file still being written).
 */
export function readImageSize(uri: vscode.Uri, fileSize: number, fs: SafeFs, signal?: AbortSignal): Promise<ImageSize | null> {
  if (uri.scheme !== 'file') {
    return fs.readFile(uri).then((data) => {
      const r = parseImageSize(data, true);
      return r === 'more' ? null : r;
    });
  }
  return fs.retry(`read header ${uri.fsPath}`, () => readLocalHeader(uri.fsPath, fileSize), signal);
}

async function readLocalHeader(path: string, fileSize: number): Promise<ImageSize | null> {
  const fh = await open(path, 'r');
  try {
    let buf: Buffer = Buffer.alloc(0);
    let want = Math.min(fileSize, 64 * 1024);
    for (;;) {
      const chunk = Buffer.alloc(Math.max(0, want - buf.length));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, buf.length);
      buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
      const complete = bytesRead < chunk.length || buf.length >= fileSize;
      const r = parseImageSize(buf, complete);
      if (r !== 'more') return r;
      want = Math.min(fileSize, want * 4);
    }
  } finally {
    await fh.close();
  }
}

type IndexRow = [size: number, mtime: number, w: number, h: number, metrics?: ImageMetrics];

/** Persisted per-dataset dimensions, keyed by relative path and validated by size + mtime. */
export class DimsIndex {
  private rows: Record<string, IndexRow> = {};
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: vscode.Uri,
    private readonly fs: SafeFs,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async load(): Promise<void> {
    let data: Uint8Array;
    try {
      data = await this.fs.readFile(this.file);
    } catch (e) {
      if (isNotFound(e)) return;
      // The index is only a cache: without it sizes are re-read from the images.
      this.log.warn(`Cannot read dimensions index ${this.file.fsPath}: ${describeError(e)}`);
      return;
    }
    try {
      this.rows = JSON.parse(new TextDecoder().decode(data));
    } catch (e) {
      this.log.warn(`Ignoring corrupt dimensions index ${this.file.fsPath}: ${describeError(e)}`);
      this.rows = {};
    }
  }

  /** undefined = not indexed; {w:0,h:0} = indexed but unreadable header. */
  get(id: string, size: number, mtime: number): ImageSize | undefined {
    const r = this.rows[id];
    return r && r[0] === size && r[1] === mtime ? { w: r[2], h: r[3] } : undefined;
  }

  set(id: string, size: number, mtime: number, w: number, h: number): void {
    const prev = this.rows[id];
    const metrics = prev && prev[0] === size && prev[1] === mtime ? prev[4] : undefined;
    this.rows[id] = metrics ? [size, mtime, w, h, metrics] : [size, mtime, w, h];
    this.scheduleSave();
  }

  getMetrics(id: string, size: number, mtime: number): ImageMetrics | undefined {
    const r = this.rows[id];
    // Rows saved without `sharpness` hold a blur value on another scale and are re-analysed.
    return r && r[0] === size && r[1] === mtime && typeof r[4]?.sharpness === 'number' ? r[4] : undefined;
  }

  /** Stored next to the dimensions; dropped with them when the file changes. */
  setMetrics(id: string, size: number, mtime: number, w: number, h: number, metrics: ImageMetrics): void {
    this.rows[id] = [size, mtime, w, h, metrics];
    this.scheduleSave();
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of Object.keys(this.rows)) if (!ids.has(id)) delete this.rows[id];
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 2000);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      await this.save();
    } else {
      await this.saving;
    }
  }

  /** Saves are serialized so two writes of the same file never overlap. */
  private save(): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(this.rows));
    this.saving = this.saving.then(async () => {
      try {
        await this.fs.createDirectory(vscode.Uri.joinPath(this.file, '..'));
        await this.fs.writeFileAtomic(this.file, data);
      } catch (e) {
        this.log.error(`Failed to save dimensions index ${this.file.fsPath}: ${describeError(e)}`);
      }
    });
    return this.saving;
  }
}
