import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { TaskQueue } from '../shared/taskQueue';
import { describeError, isNotFound, type SafeFs } from './safeFs';

const KEY_RE = /^[0-9a-f]{40}$/;
const STALE_TMP_MS = 60 * 60 * 1000;

export class ThumbCache {
  readonly dir: vscode.Uri;

  constructor(
    storage: vscode.Uri,
    private readonly fs: SafeFs,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.dir = vscode.Uri.joinPath(storage, 'thumbs');
  }

  async init(): Promise<void> {
    await this.fs.createDirectory(this.dir);
  }

  static key(file: vscode.Uri, size: number, mtime: number, resolution: number): string {
    return createHash('sha1').update(`${file.toString()}|${size}|${mtime}|${resolution}`).digest('hex');
  }

  static isKey(key: string): boolean {
    return KEY_RE.test(key);
  }

  async listKeys(): Promise<Set<string>> {
    let items: [string, vscode.FileType][];
    try {
      items = await this.fs.readDirectory(this.dir);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      // Cache folder removed from outside while running.
      await this.init();
      return new Set();
    }
    const keys = new Set<string>();
    for (const [name, type] of items) {
      if (type === vscode.FileType.File && name.endsWith('.webp')) keys.add(name.slice(0, -5));
    }
    return keys;
  }

  /** Re-keys a cached thumbnail; returns false when there was none. */
  async move(from: string, to: string): Promise<boolean> {
    if (!ThumbCache.isKey(from) || !ThumbCache.isKey(to)) throw new Error(`Invalid thumbnail key: ${from} -> ${to}`);
    try {
      await this.fs.retry(`move thumbnail ${from}`, () =>
        vscode.workspace.fs.rename(vscode.Uri.joinPath(this.dir, `${from}.webp`), vscode.Uri.joinPath(this.dir, `${to}.webp`), { overwrite: true }),
      );
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    if (!ThumbCache.isKey(key)) throw new Error(`Invalid thumbnail key: ${key}`);
    const target = vscode.Uri.joinPath(this.dir, `${key}.webp`);
    try {
      await this.fs.writeFileAtomic(target, data);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      await this.init();
      await this.fs.writeFileAtomic(target, data);
    }
  }

  /** Deletes the oldest thumbnails (by write time) until the cache is below 80% of the limit, plus stale temp files. */
  async prune(limitBytes: number): Promise<void> {
    const items = await this.fs.readDirectory(this.dir);
    const q = new TaskQueue(16);
    const now = Date.now();
    const stats = await Promise.all(
      items
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) =>
          q.add(name, 0, async () => {
            const uri = vscode.Uri.joinPath(this.dir, name);
            try {
              const st = await this.fs.stat(uri);
              return { name, uri, size: st.size, mtime: st.mtime };
            } catch (e) {
              if (isNotFound(e)) return undefined;
              this.log.warn(`Cache prune: cannot stat ${name}: ${describeError(e)}`);
              return undefined;
            }
          }),
        ),
    );
    const files = stats.filter((f) => f !== undefined);

    for (const f of files) {
      if (f.name.endsWith('.tmp') && now - f.mtime > STALE_TMP_MS) await this.removeQuietly(f.uri);
    }

    const thumbs = files.filter((f) => f.name.endsWith('.webp'));
    let total = thumbs.reduce((s, f) => s + f.size, 0);
    if (total <= limitBytes) return;
    const target = limitBytes * 0.8;
    thumbs.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const f of thumbs) {
      if (total <= target) break;
      if (await this.removeQuietly(f.uri)) removed++;
      total -= f.size;
    }
    this.log.info(`Thumbnail cache pruned: removed ${removed} files, ${(total / 1048576).toFixed(1)} MB left`);
  }

  async clear(): Promise<void> {
    await this.fs.deleteIfExists(this.dir, { recursive: true, useTrash: false });
    await this.init();
  }

  /** A failed deletion during pruning is logged and skipped; pruning is retried on the next start. */
  private async removeQuietly(uri: vscode.Uri): Promise<boolean> {
    try {
      return await this.fs.deleteIfExists(uri, { useTrash: false });
    } catch (e) {
      this.log.warn(`Cache prune: cannot delete ${uri.fsPath}: ${describeError(e)}`);
      return false;
    }
  }
}
