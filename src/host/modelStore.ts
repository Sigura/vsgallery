import * as vscode from 'vscode';
import { open, rename, rm, stat } from 'node:fs/promises';
import { describeError, errnoOf, type SafeFs } from './safeFs';
import { withRetry } from '../shared/retry';
import { CancelledError } from '../shared/taskQueue';
import { TAGGER_FILES, TAGGER_MODELS, type TaggerModelInfo, type TaggerSettings } from '../shared/tagger';

class TransientDownloadError extends Error {}

/**
 * Tagger models, looked up in this order: the user's model folder setting, models/<id> shipped in
 * the extension package, globalStorage/models/<id> (downloaded from Hugging Face on demand).
 */
export class ModelStore {
  private readonly downloaded: vscode.Uri;
  private readonly bundled: vscode.Uri;
  private readonly downloads = new Map<string, Promise<boolean>>();

  constructor(
    extensionUri: vscode.Uri,
    globalStorage: vscode.Uri,
    private readonly fs: SafeFs,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.bundled = vscode.Uri.joinPath(extensionUri, 'models');
    this.downloaded = vscode.Uri.joinPath(globalStorage, 'models');
  }

  /** Folders the webview must be allowed to read model files from. */
  resourceRoots(s: TaggerSettings): vscode.Uri[] {
    const roots = [this.bundled, this.downloaded];
    if (s.modelFolder.trim()) roots.push(vscode.Uri.file(s.modelFolder.trim()));
    return roots;
  }

  /**
   * Folder containing all model files, downloading them after the user agreed.
   * Undefined when the user declined or cancelled the download.
   */
  async ensure(s: TaggerSettings): Promise<vscode.Uri | undefined> {
    if (s.modelFolder.trim()) {
      const custom = vscode.Uri.file(s.modelFolder.trim());
      const missing = await this.missingFiles(custom);
      if (missing.length) throw new Error(`${missing.join(', ')} not found in the tagger model folder ${custom.fsPath}`);
      return custom;
    }
    const bundled = vscode.Uri.joinPath(this.bundled, s.model);
    if (!(await this.missingFiles(bundled)).length) return bundled;
    const dir = vscode.Uri.joinPath(this.downloaded, s.model);
    const missing = await this.missingFiles(dir);
    if (!missing.length) return dir;
    const info = TAGGER_MODELS[s.model];
    let pending = this.downloads.get(info.id);
    if (!pending) {
      pending = this.confirmAndDownload(info, dir, missing).finally(() => this.downloads.delete(info.id));
      this.downloads.set(info.id, pending);
    }
    return (await pending) ? dir : undefined;
  }

  private async missingFiles(dir: vscode.Uri): Promise<string[]> {
    const missing: string[] = [];
    for (const f of TAGGER_FILES) if (!(await this.fs.exists(vscode.Uri.joinPath(dir, f)))) missing.push(f);
    return missing;
  }

  private async confirmAndDownload(info: TaggerModelInfo, dir: vscode.Uri, files: string[]): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      `Download the ${info.id} caption model (${info.approxDownload}) from huggingface.co?`,
      {
        modal: true,
        detail: `Files: ${files.join(', ')}\nSaved to: ${dir.fsPath}\n\nTo use a model you already have, set "loraDataset.tagger.modelFolder" instead.`,
      },
      'Download',
    );
    if (choice !== 'Download') return false;
    await this.fs.createDirectory(dir);
    const controller = new AbortController();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${info.id}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => controller.abort());
          for (const f of files) {
            const url = `https://huggingface.co/${info.repo}/resolve/main/${f}`;
            const target = vscode.Uri.joinPath(dir, f).fsPath;
            let reported = 0;
            await this.downloadFile(url, `${target}.part`, controller.signal, (done, total) => {
              const pct = total > 0 ? (done / total) * 100 : 0;
              progress.report({
                message: `${f}: ${(done / 1048576).toFixed(0)}${total > 0 ? ` / ${(total / 1048576).toFixed(0)}` : ''} MB`,
                increment: f === 'model.onnx' ? pct - reported : undefined,
              });
              reported = pct;
            });
            await rename(`${target}.part`, target);
            this.log.info(`Downloaded ${url} to ${target}`);
          }
        },
      );
      return true;
    } catch (e) {
      if (controller.signal.aborted) {
        this.log.info(`Download of ${info.id} cancelled; partial files are kept and resumed next time`);
        return false;
      }
      this.log.error(`Downloading ${info.id} failed: ${describeError(e)}`);
      throw new Error(`Downloading ${info.id} failed: ${describeError(e)}`);
    }
  }

  /** Streams `url` into `dest`, resuming a partial file with a Range request when the server supports it. */
  private downloadFile(url: string, dest: string, signal: AbortSignal, onBytes: (done: number, total: number) => void): Promise<void> {
    return withRetry(
      async () => {
        let start = 0;
        try {
          start = (await stat(dest)).size;
        } catch (e) {
          if (errnoOf(e) !== 'ENOENT') throw e;
        }
        const res = await fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal });
        if (res.status === 416) {
          // The partial file is not a prefix of the current file (or already as long): start over.
          await rm(dest, { force: true });
          throw new TransientDownloadError('HTTP 416, restarting download');
        }
        if (res.status === 408 || res.status === 429 || res.status >= 500) throw new TransientDownloadError(`HTTP ${res.status}`);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
        const resumed = res.status === 206;
        let done = resumed ? start : 0;
        const length = Number(res.headers.get('content-length'));
        const total = Number.isFinite(length) && length > 0 ? done + length : 0;
        const fh = await open(dest, resumed ? 'a' : 'w');
        try {
          for await (const chunk of res.body) {
            await fh.write(chunk);
            done += chunk.byteLength;
            onBytes(done, total);
          }
        } finally {
          await fh.close();
        }
        if (total && done !== total) throw new TransientDownloadError(`Connection closed after ${done} of ${total} bytes`);
      },
      {
        retries: 10,
        baseDelayMs: 1000,
        maxDelayMs: 15000,
        signal,
        // fetch() rejects with TypeError on network failures; an aborted body read surfaces as AbortError.
        isRetryable: (e) => !signal.aborted && (e instanceof TransientDownloadError || e instanceof TypeError),
        onRetry: (e, attempt, delay) => this.log.warn(`Download ${url}: ${describeError(e)}; retry ${attempt} in ${delay} ms`),
      },
    ).catch((e: unknown) => {
      throw signal.aborted ? new CancelledError() : e;
    });
  }
}
