import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { withRetry } from '../shared/retry';

const TRANSIENT_ERRNO = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'ECONNRESET', 'EIO', 'ESTALE', 'EINTR']);
if (process.platform === 'win32') {
  // Antivirus, indexers and cloud sync clients hold short-lived locks that surface as EPERM/EACCES.
  TRANSIENT_ERRNO.add('EPERM');
  TRANSIENT_ERRNO.add('EACCES');
}

/** Node errno code, also when wrapped in a vscode.FileSystemError (which keeps it only in the message). */
export function errnoOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
  return e instanceof Error ? /\b(E[A-Z]{3,})\b/.exec(e.message)?.[1] : undefined;
}

export function isNotFound(e: unknown): boolean {
  return (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') || errnoOf(e) === 'ENOENT';
}

export function isTransientFsError(e: unknown): boolean {
  if (isNotFound(e)) return false;
  if (e instanceof vscode.FileSystemError && e.code === 'Unavailable') return true;
  const errno = errnoOf(e);
  return errno !== undefined && TRANSIENT_ERRNO.has(errno);
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** vscode.workspace.fs with retries (exponential backoff) for transient errors such as locked or busy files. */
export class SafeFs {
  constructor(private readonly log: vscode.LogOutputChannel) {}

  retry<T>(what: string, fn: () => Thenable<T> | Promise<T>, signal?: AbortSignal): Promise<T> {
    return withRetry(() => Promise.resolve(fn()), {
      retries: 10,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      isRetryable: isTransientFsError,
      signal,
      onRetry: (e, attempt, delay) => this.log.warn(`${what}: ${describeError(e)}; retry ${attempt} in ${delay} ms`),
    });
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.retry(`stat ${uri.fsPath}`, () => vscode.workspace.fs.stat(uri));
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.retry(`readDirectory ${uri.fsPath}`, () => vscode.workspace.fs.readDirectory(uri));
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.retry(`readFile ${uri.fsPath}`, () => vscode.workspace.fs.readFile(uri));
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.retry(`createDirectory ${uri.fsPath}`, () => vscode.workspace.fs.createDirectory(uri));
  }

  async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await this.stat(uri);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  /** Copies without overwriting; returns false when the target already exists. */
  async copyIfAbsent(from: vscode.Uri, to: vscode.Uri): Promise<boolean> {
    try {
      await this.retry(`copy ${from.fsPath}`, () => vscode.workspace.fs.copy(from, to, { overwrite: false }));
      return true;
    } catch (e) {
      if (e instanceof vscode.FileSystemError && e.code === 'FileExists') return false;
      throw e;
    }
  }

  /** Returns false when the target was already gone. */
  async deleteIfExists(uri: vscode.Uri, options: { recursive?: boolean; useTrash?: boolean }): Promise<boolean> {
    try {
      await this.retry(`delete ${uri.fsPath}`, () => vscode.workspace.fs.delete(uri, options));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  /** Writes to a temp file next to the target and renames it over, so readers never see a partial file. */
  async writeFileAtomic(uri: vscode.Uri, data: Uint8Array): Promise<void> {
    const tmp = uri.with({ path: `${uri.path}.${randomBytes(4).toString('hex')}.tmp` });
    try {
      await this.retry(`writeFile ${tmp.fsPath}`, () => vscode.workspace.fs.writeFile(tmp, data));
      await this.retry(`rename ${tmp.fsPath}`, () => vscode.workspace.fs.rename(tmp, uri, { overwrite: true }));
    } catch (e) {
      await this.deleteIfExists(tmp, { useTrash: false }).catch((cleanup: unknown) =>
        this.log.warn(`Could not remove temp file ${tmp.fsPath}: ${describeError(cleanup)}`),
      );
      throw e;
    }
  }
}
