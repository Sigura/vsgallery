import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { DimsIndex, isHiddenPath, relUri, splitRel } from './datasetScanner';
import { Dataset, type DatasetOptions } from './dataset';
import { ThumbCache } from './thumbCache';
import { runTagOp } from './tagBatch';
import { describeError, isNotFound, type SafeFs } from './safeFs';
import type { ModelStore } from './modelStore';
import { TaskQueue } from '../shared/taskQueue';
import type { GallerySettings, HostToWebview, ResizeOutput, WebviewToHost } from '../shared/protocol';
import { decodeCaption } from '../shared/captions';
import { combineCaption, TAGGER_FILES, TAGGER_MODELS, type ExistingCaptionMode, type TaggerModelId, type TaggerSettings } from '../shared/tagger';

export interface Services {
  context: vscode.ExtensionContext;
  cache: ThumbCache;
  fs: SafeFs;
  log: vscode.LogOutputChannel;
  models: ModelStore;
}

const WATCH_DEBOUNCE_MS = 300;
const WATCH_MAX_DELAY_MS = 2000;

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function config() {
  const c = vscode.workspace.getConfiguration('loraDataset');
  const settings: GallerySettings = {
    concurrency: c.get<number>('concurrency', 3),
    thumbnailSize: c.get<number>('thumbnailSize', 160),
    thumbnailResolution: c.get<number>('thumbnailResolution', 384),
    minResolution: c.get<number>('minResolution', 512),
    captionAutosave: c.get<boolean>('captionAutosave', true),
    captionAutosaveDelay: c.get<number>('captionAutosaveDelay', 800),
    brushSizeMode: c.get<'screen' | 'image'>('brushSizeMode', 'screen'),
    jpegQuality: c.get<number>('jpegQuality', 0.95),
    undoMemoryMB: c.get<number>('undoMemoryMB', 512),
    snapMultiple: c.get<number>('snapMultiple', 8),
    editorBackup: c.get<boolean>('editorBackup', true),
    tagger: taggerConfig(c),
    quality: {
      minResolution: c.get<number>('minResolution', 512),
      blurThreshold: c.get<number>('quality.blurThreshold', 100),
      maxAspect: c.get<number>('quality.maxAspect', 2.5),
      minWords: c.get<number>('quality.minWords', 3),
      maxTokens: c.get<number>('quality.maxTokens', 75),
    },
  };
  const dataset: DatasetOptions = {
    resolution: settings.thumbnailResolution,
    concurrency: settings.concurrency,
    captionExts: c.get<string[]>('captionExtensions', ['.txt', '.caption']),
  };
  return { settings, dataset, pollSeconds: c.get<number>('pollIntervalSeconds', 0), debug: c.get<boolean>('debug', true) };
}

function taggerConfig(c: vscode.WorkspaceConfiguration): TaggerSettings {
  const model = c.get<string>('tagger.model', 'wd-vit-tagger-v3');
  return {
    model: model in TAGGER_MODELS ? (model as TaggerModelId) : 'wd-vit-tagger-v3',
    modelFolder: c.get<string>('tagger.modelFolder', ''),
    generalThreshold: c.get<number>('tagger.generalThreshold', 0.35),
    characterThreshold: c.get<number>('tagger.characterThreshold', 0.85),
    excludeTags: c.get<string[]>('tagger.excludeTags', []),
    replaceUnderscores: c.get<boolean>('tagger.replaceUnderscores', true),
    triggerWord: c.get<string>('tagger.triggerWord', ''),
    existingCaptions: c.get<ExistingCaptionMode>('tagger.existingCaptions', 'skip'),
    backend: c.get<TaggerSettings['backend']>('tagger.backend', 'auto'),
  };
}

export class GalleryPanel {
  static readonly viewType = 'loraDataset.gallery';
  private static readonly panels = new Map<string, GalleryPanel>();
  private static active: GalleryPanel | undefined;

  private readonly dataset: Dataset;
  private readonly dims: DimsIndex;
  private settings: GallerySettings;
  /** Resolves once the first scan has started; the webview then gets a snapshot and streamed deltas. */
  private readonly scanStarted: Promise<void>;
  private readonly debug: boolean;
  /** Debug lines from before the webview was ready; sent with the first 'ready'. */
  private debugBacklog: string[] | undefined = [];
  private backlogError = false;
  private scanning = false;
  private scanError: string | undefined;
  private selection: string[] = [];
  private pendingReveal: { id: string; open: boolean } | undefined;
  private changed = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private firstChangeAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(svc: Services, folder: vscode.Uri, reveal?: { id: string; open: boolean }): void {
    const existing = GalleryPanel.panels.get(folder.toString());
    if (existing) {
      existing.panel.reveal();
      if (reveal) existing.post({ type: 'reveal', ...reveal });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      GalleryPanel.viewType,
      GalleryPanel.title(folder),
      vscode.ViewColumn.Active,
      GalleryPanel.webviewOptions(svc, folder),
    );
    new GalleryPanel(svc, panel, folder, reveal ? 'open image' : 'open folder', reveal);
  }

  /** Opens an image in the detail view of a gallery that already contains it, else of its parent folder. */
  static openImage(svc: Services, image: vscode.Uri): void {
    let best: { panel: GalleryPanel; rel: string } | undefined;
    for (const p of GalleryPanel.panels.values()) {
      const base = p.folder.path.endsWith('/') ? p.folder.path : `${p.folder.path}/`;
      if (p.folder.scheme !== image.scheme || p.folder.authority !== image.authority || !image.path.startsWith(base)) continue;
      const rel = image.path.slice(base.length);
      if (!best || rel.length < best.rel.length) best = { panel: p, rel };
    }
    if (best) {
      best.panel.panel.reveal();
      best.panel.post({ type: 'reveal', id: best.rel, open: true });
      return;
    }
    const name = image.path.slice(image.path.lastIndexOf('/') + 1);
    GalleryPanel.createOrShow(svc, vscode.Uri.joinPath(image, '..'), { id: name, open: true });
  }

  static revive(svc: Services, panel: vscode.WebviewPanel, folder: vscode.Uri): void {
    if (GalleryPanel.panels.has(folder.toString())) {
      panel.dispose();
      return;
    }
    panel.webview.options = GalleryPanel.webviewOptions(svc, folder);
    new GalleryPanel(svc, panel, folder, 'restored');
  }

  static refreshAll(): void {
    for (const p of GalleryPanel.panels.values()) void p.rescan();
  }

  static deleteSelectedInActive(): void {
    const p = GalleryPanel.active;
    if (p) void p.deleteImages(p.selection);
  }

  static autoCaptionInActive(): void {
    GalleryPanel.active?.post({ type: 'autoCaption' });
  }

  private static title(folder: vscode.Uri): string {
    return `Dataset: ${folder.path.slice(folder.path.lastIndexOf('/') + 1)}`;
  }

  private static webviewOptions(svc: Services, folder: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        folder,
        svc.cache.dir,
        vscode.Uri.joinPath(svc.context.extensionUri, 'dist', 'webview'),
        ...svc.models.resourceRoots(taggerConfig(vscode.workspace.getConfiguration('loraDataset'))),
      ],
    };
  }

  private constructor(
    private readonly svc: Services,
    private readonly panel: vscode.WebviewPanel,
    private readonly folder: vscode.Uri,
    origin: string,
    reveal?: { id: string; open: boolean },
  ) {
    GalleryPanel.panels.set(folder.toString(), this);
    GalleryPanel.active = this;
    this.pendingReveal = reveal;
    const cfg = config();
    this.settings = cfg.settings;
    this.debug = cfg.debug;
    this.dbg(`panel for ${folder.toString()} (${origin})`);
    const indexName = createHash('sha1').update(folder.toString()).digest('hex');
    this.dims = new DimsIndex(vscode.Uri.joinPath(svc.context.globalStorageUri, 'dims', `${indexName}.json`), svc.fs, svc.log);
    this.dataset = new Dataset(folder, svc.fs, svc.cache, this.dims, svc.log, {
      delta: (upserts, removed) => {
        this.dbg(`delta +${upserts.length} -${removed.length} (dataset now ${this.dataset.entries.size})`);
        this.post({ type: 'delta', upserts, removed });
      },
      patch: (patches) => this.post({ type: 'patch', patches }),
      skipped: (items) => this.reportSkipped(items),
    }, cfg.dataset);

    panel.iconPath = new vscode.ThemeIcon('file-media');
    panel.webview.html = this.html();
    if (this.debug) this.watchLoad();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) GalleryPanel.active = this;
      }),
      panel.webview.onDidReceiveMessage((m: WebviewToHost) =>
        this.onMessage(m).catch((e: unknown) => {
          svc.log.error(`Handling '${m.type}' failed: ${describeError(e)}`);
          this.dbg(`Handling '${m.type}' failed: ${e instanceof Error ? (e.stack ?? e.message) : describeError(e)}`, true);
        }),
      ),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('loraDataset')) this.onSettingsChanged();
      }),
    );
    this.startWatching();
    this.setPolling(cfg.pollSeconds);
    this.scanStarted = this.dims.load().then(() => {
      this.dbg('dimensions index loaded');
      void this.rescan();
    });
  }

  private post(msg: HostToWebview): void {
    this.panel.webview.postMessage(msg).then(
      (ok) => {
        if (!ok && msg.type !== 'debug') this.dbg(`postMessage '${msg.type}' not delivered`);
      },
      (e: unknown) => this.svc.log.error(`postMessage '${msg.type}' failed: ${describeError(e)}`),
    );
  }

  /**
   * The page reports 'ready' as its first action; when that never arrives the webview itself failed
   * to load (blank panel, no toolbar), which nothing inside the page can report.
   */
  private watchLoad(): void {
    const timer = setTimeout(() => {
      if (!this.debugBacklog) return;
      // A tab in the background may not load its page until it is shown.
      if (!this.panel.visible) {
        this.watchLoad();
        return;
      }
      const what = `Gallery page for ${this.folder.fsPath} did not load within 10 s (active=${this.panel.active}).`;
      this.svc.log.warn(`${what} Debug lines so far:\n${this.debugBacklog.join('\n')}`);
      void vscode.window.showWarningMessage(`LoRA Dataset: ${what}`, 'Reload Page', 'Show Log').then((choice) => {
        if (choice === 'Reload Page') {
          this.dbg('page reloaded by user');
          this.panel.webview.html = this.html();
          this.watchLoad();
        } else if (choice === 'Show Log') {
          this.svc.log.show();
        }
      });
    }, 10_000);
    this.disposables.push({ dispose: () => clearTimeout(timer) });
  }

  /** `error`: also expands the debug panel in the page. */
  private dbg(line: string, error = false): void {
    if (!this.debug) return;
    this.svc.log.debug(line);
    if (this.debugBacklog) {
      this.debugBacklog.push(line);
      if (this.debugBacklog.length > 300) this.debugBacklog.shift();
      this.backlogError ||= error;
    } else {
      this.post({ type: 'debug', lines: [line], error });
    }
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        if (this.debugBacklog) {
          this.post({ type: 'debug', lines: this.debugBacklog, error: this.backlogError });
          this.debugBacklog = undefined;
        }
        this.dbg('webview ready');
        await this.scanStarted;
        this.dbg(`sending init with ${this.dataset.entries.size} entries, scanning=${this.scanning}`);
        this.post({
          type: 'init',
          folderName: this.folder.path.slice(this.folder.path.lastIndexOf('/') + 1),
          folderUri: this.folder.toString(),
          folderPath: this.folder.fsPath,
          imageBase: this.panel.webview.asWebviewUri(this.folder).toString(),
          thumbBase: this.panel.webview.asWebviewUri(this.svc.cache.dir).toString(),
          settings: this.settings,
          entries: [...this.dataset.entries.values()],
          scanning: this.scanning,
          error: this.scanError,
          reveal: this.pendingReveal?.id,
          open: this.pendingReveal?.open,
        });
        this.pendingReveal = undefined;
        return;
      case 'refresh':
        await this.rescan();
        return;
      case 'thumbData':
        await this.saveThumb(m.id, m.key, m.data, m.w, m.h);
        return;
      case 'selection':
        this.selection = m.ids;
        return;
      case 'delete':
        await this.deleteImages(m.ids);
        return;
      case 'saveCaption':
        await this.saveCaption(m.id, m.text);
        return;
      case 'saveImage':
        await this.saveImage(m.id, m.mode, m.data);
        return;
      case 'taggerModel':
        await this.sendTaggerModel(m.requestId);
        return;
      case 'writeResized':
        await this.writeResized(m.requestId, m.id, m.data, m.output);
        return;
      case 'applyCaption':
        await this.applyCaption(m.requestId, m.id, m.tags, m.mode);
        return;
      case 'metrics':
        for (const it of m.items) this.dataset.setMetrics(it.id, it.key, it.metrics);
        return;
      case 'tagOp': {
        const ctx = { dataset: this.dataset, fs: this.svc.fs, folder: this.folder, log: this.svc.log };
        const r = await runTagOp(ctx, m.ids, m.op, m.dryRun);
        this.post({ type: 'tagOpResult', requestId: m.requestId, applied: !m.dryRun, ...r });
        return;
      }
      case 'moveImages':
        await this.moveImages(m.ids, m.dir);
        return;
      case 'revealInExplorer':
        await this.revealInExplorer(m.id);
        return;
      case 'renameFolders':
        await this.renameFolders(m.requestId, m.renames);
        return;
      case 'error':
        this.svc.log.error(`[webview] ${m.message}`);
        return;
    }
  }

  /** Full rescan diffed against the current state; scroll position and selection survive in the webview. */
  private async rescan(): Promise<void> {
    this.scanning = true;
    this.post({ type: 'status', scanning: true });
    const t0 = Date.now();
    this.dbg('scan started');
    try {
      await this.dataset.scan();
      this.scanError = undefined;
      this.dbg(`scan finished in ${Date.now() - t0} ms: ${this.dataset.entries.size} images`);
    } catch (e) {
      this.dbg(`scan FAILED after ${Date.now() - t0} ms: ${describeError(e)}`, true);
      this.scanError = `Scan failed: ${describeError(e)}`;
      this.svc.log.error(`Scan of ${this.folder.fsPath} failed: ${describeError(e)}`);
      void vscode.window.showErrorMessage(`LoRA Dataset: failed to scan ${this.folder.fsPath}: ${describeError(e)}`);
    } finally {
      this.scanning = false;
      this.post({ type: 'status', scanning: false, error: this.scanError });
    }
  }

  private startWatching(): void {
    // A RelativePattern with a Uri base also watches folders outside the workspace.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
    const onEvent = (uri: vscode.Uri) => this.queueChange(uri);
    this.disposables.push(watcher, watcher.onDidCreate(onEvent), watcher.onDidChange(onEvent), watcher.onDidDelete(onEvent));
  }

  /** Coalesces bursts: flushes after 300 ms of quiet, but at the latest 2 s after the first event. */
  private queueChange(uri: vscode.Uri): void {
    const base = this.folder.path.endsWith('/') ? this.folder.path : `${this.folder.path}/`;
    let rel: string;
    if (uri.path === this.folder.path) rel = '';
    else if (uri.path.startsWith(base)) rel = uri.path.slice(base.length);
    else return;
    if (!this.changed.size) this.firstChangeAt = Date.now();
    this.changed.add(rel);
    clearTimeout(this.debounceTimer);
    const wait = Math.max(0, Math.min(WATCH_DEBOUNCE_MS, this.firstChangeAt + WATCH_MAX_DELAY_MS - Date.now()));
    this.debounceTimer = setTimeout(() => this.flushChanges(), wait);
  }

  private flushChanges(): void {
    const paths = this.changed;
    this.changed = new Set();
    this.dataset
      .refresh(paths)
      .catch((e: unknown) => this.svc.log.error(`Incremental refresh failed: ${describeError(e)}`));
  }

  private setPolling(seconds: number): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (seconds > 0) {
      this.pollTimer = setInterval(() => {
        if (!this.scanning) void this.rescan();
      }, seconds * 1000);
    }
  }

  private async saveThumb(id: string, key: string, data: Uint8Array | ArrayBuffer, w: number, h: number): Promise<void> {
    const entry = this.dataset.entries.get(id);
    if (!entry || entry.thumb !== key) return;
    try {
      await this.svc.cache.write(key, data instanceof Uint8Array ? data : new Uint8Array(data));
    } catch (e) {
      this.svc.log.error(`Failed to write thumbnail for ${id}: ${describeError(e)}`);
      return;
    }
    this.dataset.markThumb(id, key);
    this.post({ type: 'thumbSaved', id, key });
    if (entry.w === 0 && w > 0 && h > 0) this.dataset.setDims(id, w, h);
  }

  private async saveCaption(id: string, text: string): Promise<void> {
    if (!this.dataset.entries.has(id)) {
      this.post({ type: 'captionSaved', id, text, error: 'Image no longer exists' });
      return;
    }
    try {
      const rel = await this.dataset.captionTarget(id);
      await this.svc.fs.writeFileAtomic(relUri(this.folder, rel), new TextEncoder().encode(text));
      await this.dataset.refresh([rel]);
      this.post({ type: 'captionSaved', id, text });
    } catch (e) {
      this.svc.log.error(`Saving caption of ${id} failed: ${describeError(e)}`);
      this.post({ type: 'captionSaved', id, text, error: describeError(e) });
    }
  }

  private async sendTaggerModel(requestId: number): Promise<void> {
    const s = this.settings.tagger;
    try {
      const dir = await this.svc.models.ensure(s);
      if (!dir) {
        this.post({ type: 'taggerModel', requestId, cancelled: true, error: 'Model download cancelled' });
        return;
      }
      const [model, tags] = TAGGER_FILES.map((f) => vscode.Uri.joinPath(dir, f));
      const st = await this.svc.fs.stat(model);
      const webview = this.panel.webview;
      this.post({
        type: 'taggerModel',
        requestId,
        model: {
          modelUrl: webview.asWebviewUri(model).toString(),
          tagsUrl: webview.asWebviewUri(tags).toString(),
          inputSize: TAGGER_MODELS[s.model].inputSize,
          version: `${model.toString()}|${st.size}|${st.mtime}`,
          label: s.modelFolder.trim() ? dir.fsPath : s.model,
        },
      });
    } catch (e) {
      this.svc.log.error(`Preparing the tagger model failed: ${describeError(e)}`);
      this.post({ type: 'taggerModel', requestId, error: describeError(e) });
    }
  }

  /** Combines generated tags with the caption file as it is on disk now, so concurrent edits are not lost. */
  private async applyCaption(requestId: number, id: string, tags: string[], mode: ExistingCaptionMode): Promise<void> {
    const reply = (extra: { text?: string; skipped?: boolean; error?: string }) =>
      this.post({ type: 'captionApplied', requestId, id, ...extra });
    if (!this.dataset.entries.has(id)) return reply({ error: 'Image no longer exists' });
    try {
      const rel = await this.dataset.captionTarget(id);
      const uri = relUri(this.folder, rel);
      let existing: string | null = null;
      try {
        existing = decodeCaption(await this.svc.fs.readFile(uri));
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      const text = combineCaption(existing, tags, mode, this.settings.tagger.triggerWord);
      if (text === undefined) return reply({ skipped: true });
      await this.svc.fs.writeFileAtomic(uri, new TextEncoder().encode(text));
      await this.dataset.refresh([rel]);
      reply({ text });
    } catch (e) {
      this.svc.log.error(`Writing generated caption of ${id} failed: ${describeError(e)}`);
      reply({ error: describeError(e) });
    }
  }

  /** Writes a batch-resized image in place (with backup) or into an output folder together with its caption. */
  private async writeResized(requestId: number, id: string, data: Uint8Array | ArrayBuffer, output: ResizeOutput): Promise<void> {
    const reply = (error?: string) => this.post({ type: 'resizeWritten', requestId, id, error });
    const entry = this.dataset.entries.get(id);
    if (!entry) return reply('Image no longer exists');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const fs = this.svc.fs;
    try {
      if (output.kind === 'overwrite') {
        if (vscode.workspace.getConfiguration('loraDataset').get<boolean>('editorBackup', true)) {
          await fs.copyIfAbsent(relUri(this.folder, id), relUri(this.folder, `${id}.bak`));
        }
        await fs.writeFileAtomic(relUri(this.folder, id), bytes);
        await this.dataset.refresh([id]);
        return reply();
      }
      const root = vscode.Uri.file(output.path);
      const base = this.folder.path.endsWith('/') ? this.folder.path : `${this.folder.path}/`;
      if (!output.path.trim() || root.path === this.folder.path || root.path.startsWith(base)) {
        throw new Error('The output folder must be outside the dataset folder');
      }
      const target = relUri(root, id);
      await fs.createDirectory(vscode.Uri.joinPath(target, '..'));
      await fs.writeFileAtomic(target, bytes);
      if (entry.captionFile) {
        const from = relUri(this.folder, entry.captionFile);
        const to = relUri(root, entry.captionFile);
        await fs.retry(`copy ${from.fsPath}`, () => vscode.workspace.fs.copy(from, to, { overwrite: true }));
      }
      reply();
    } catch (e) {
      this.svc.log.error(`Writing resized ${id} failed: ${describeError(e)}`);
      reply(describeError(e));
    }
  }

  /**
   * Overwrite keeps the first original as <name>.bak (when enabled); copy writes <stem>_edit[_n].<ext>
   * next to the image together with a copy of its caption file.
   */
  private async saveImage(id: string, mode: 'overwrite' | 'copy', data: Uint8Array | ArrayBuffer): Promise<void> {
    const reply = (extra: { newId?: string; error?: string }) => this.post({ type: 'imageSaved', id, mode, ...extra });
    const entry = this.dataset.entries.get(id);
    if (!entry) return reply({ error: 'Image no longer exists' });
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const fs = this.svc.fs;
    try {
      if (mode === 'overwrite') {
        if (vscode.workspace.getConfiguration('loraDataset').get<boolean>('editorBackup', true)) {
          await fs.copyIfAbsent(relUri(this.folder, id), relUri(this.folder, `${id}.bak`));
        }
        await fs.writeFileAtomic(relUri(this.folder, id), bytes);
        await this.dataset.refresh([id]);
        return reply({ newId: id });
      }
      const { dir, name } = splitRel(id);
      const dot = name.lastIndexOf('.');
      const prefix = dir ? `${dir}/` : '';
      const oldStem = `${prefix}${name.slice(0, dot)}`;
      let newStem = '';
      for (let n = 0; n < 1000 && !newStem; n++) {
        const candidate = `${oldStem}_edit${n ? `_${n}` : ''}`;
        if (!(await fs.exists(relUri(this.folder, candidate + name.slice(dot))))) newStem = candidate;
      }
      if (!newStem) throw new Error('No free file name for the copy');
      const newId = newStem + name.slice(dot);
      await fs.writeFileAtomic(relUri(this.folder, newId), bytes);
      const changed = [newId];
      if (entry.captionFile?.startsWith(oldStem)) {
        const newCaption = newStem + entry.captionFile.slice(oldStem.length);
        await fs.copyIfAbsent(relUri(this.folder, entry.captionFile), relUri(this.folder, newCaption));
        changed.push(newCaption);
      }
      await this.dataset.refresh(changed);
      reply({ newId });
    } catch (e) {
      this.svc.log.error(`Saving image ${id} (${mode}) failed: ${describeError(e)}`);
      reply({ error: describeError(e) });
    }
  }

  private async moveImages(ids: string[], dir: string): Promise<void> {
    if (isHiddenPath(dir) || dir.split('/').includes('..')) throw new Error(`invalid folder: ${dir}`);
    const { moved, errors } = await this.dataset.moveImages(ids, dir);
    const where = dir || 'the dataset root';
    this.dbg(`moved ${moved} image(s) to ${where}, ${errors.length} failed`);
    if (moved) vscode.window.setStatusBarMessage(`Moved ${moved} image(s) to ${where}`, 4000);
    else if (!errors.length) vscode.window.setStatusBarMessage(`The image(s) are already in ${where}`, 4000);
    if (errors.length) {
      for (const e of errors) this.svc.log.error(`Moving ${e.id} to ${where} failed: ${e.error}`);
      const shown = errors.slice(0, 5).map((e) => `${e.id}: ${e.error}`).join('\n');
      void vscode.window.showErrorMessage(`LoRA Dataset: ${errors.length} image(s) could not be moved to ${where}.`, {
        modal: true,
        detail: `${shown}${errors.length > 5 ? `\n… and ${errors.length - 5} more (see the log)` : ''}`,
      });
    }
  }

  /** The Explorer takes focus when it reveals; it is handed back so keyboard navigation keeps working. */
  private async revealInExplorer(id: string): Promise<void> {
    if (!this.dataset.entries.has(id)) return;
    await vscode.commands.executeCommand('revealInExplorer', relUri(this.folder, id));
    this.panel.reveal(this.panel.viewColumn, false);
  }

  private async renameFolders(requestId: number, renames: { from: string; to: string }[]): Promise<void> {
    const results: { from: string; to: string; error?: string }[] = [];
    for (const { from, to } of renames) {
      try {
        if (!from || !to || isHiddenPath(to) || to.split('/').includes('..')) throw new Error('invalid folder name');
        await this.dataset.renameFolder(from, to);
        this.dbg(`renamed ${from} -> ${to}`);
        results.push({ from, to });
      } catch (e) {
        this.svc.log.error(`Renaming ${from} to ${to} failed: ${describeError(e)}`);
        results.push({ from, to, error: describeError(e) });
      }
    }
    this.post({ type: 'foldersRenamed', requestId, results });
  }

  /** Permanently deletes images and their caption files. A caption is only deleted after its image was. */
  private async deleteImages(ids: readonly string[]): Promise<void> {
    const targets = ids.filter((id) => this.dataset.entries.has(id));
    if (!targets.length) return;
    if (vscode.workspace.getConfiguration('loraDataset').get<boolean>('confirmDelete', false)) {
      const shown = targets.slice(0, 8).join('\n');
      const more = targets.length > 8 ? `\n… and ${targets.length - 8} more` : '';
      const choice = await vscode.window.showWarningMessage(
        `Permanently delete ${targets.length} image(s) and their caption files?`,
        { modal: true, detail: `${shown}${more}\n\nThis cannot be undone.` },
        'Delete',
      );
      if (choice !== 'Delete') return;
    }

    const deleting = new Set(targets);
    const deleted: string[] = [];
    const failures: string[] = [];
    const q = new TaskQueue(8);
    await Promise.all(
      targets.map((id) =>
        q
          .add(id, 0, async () => {
            const captions = await this.dataset.captionFiles(id, deleting);
            try {
              await this.svc.fs.deleteIfExists(relUri(this.folder, id), { useTrash: false });
            } catch (e) {
              failures.push(`${id}: ${describeError(e)}`);
              return;
            }
            deleted.push(id);
            for (const c of captions) {
              try {
                await this.svc.fs.deleteIfExists(relUri(this.folder, c), { useTrash: false });
              } catch (e) {
                failures.push(`${c}: ${describeError(e)}`);
              }
            }
          })
          .catch((e: unknown) => failures.push(`${id}: ${describeError(e)}`)),
      ),
    );
    this.dataset.removeIds(deleted);
    this.svc.log.info(`Deleted ${deleted.length} image(s) in ${this.folder.fsPath}`);
    if (failures.length) {
      for (const f of failures) this.svc.log.error(`Delete failed: ${f}`);
      void vscode.window
        .showErrorMessage(
          `LoRA Dataset: deleted ${deleted.length} of ${targets.length} image(s); ${failures.length} file(s) could not be deleted.`,
          'Show Log',
        )
        .then((c) => c && this.svc.log.show());
    }
  }

  private reportSkipped(skipped: { path: string; reason: string }[]): void {
    this.dbg(`skipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join('; ')}`);
    for (const s of skipped) this.svc.log.warn(`Skipped ${s.path}: ${s.reason}`);
    void vscode.window
      .showWarningMessage(`LoRA Dataset: ${skipped.length} file(s)/folder(s) could not be read.`, 'Show Log')
      .then((choice) => choice && this.svc.log.show());
  }

  private onSettingsChanged(): void {
    const cfg = config();
    if (cfg.settings.tagger.modelFolder !== this.settings.tagger.modelFolder) {
      this.panel.webview.options = GalleryPanel.webviewOptions(this.svc, this.folder);
    }
    this.settings = cfg.settings;
    this.setPolling(cfg.pollSeconds);
    this.post({ type: 'settings', settings: this.settings });
    if (this.dataset.setOptions(cfg.dataset)) void this.rescan();
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.svc.context.extensionUri, 'dist', 'webview');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(base, 'gallery.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(base, 'gallery.css'));
    const worker = webview.asWebviewUri(vscode.Uri.joinPath(base, 'thumbWorker.js'));
    const analysisWorker = webview.asWebviewUri(vscode.Uri.joinPath(base, 'analysisWorker.js'));
    const tagWorker = webview.asWebviewUri(vscode.Uri.joinPath(base, 'tagWorker.js'));
    const patchWorker = webview.asWebviewUri(vscode.Uri.joinPath(base, 'patchWorker.js'));
    const nonce = randomBytes(16).toString('base64');
    const src = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} blob: data:; style-src ${src}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${src};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Dataset Gallery</title>
</head>
<body data-settings="${escapeAttr(JSON.stringify(this.settings))}" data-debug="${this.debug ? '1' : ''}" data-worker="${worker}" data-analysis-worker="${analysisWorker}" data-tag-worker="${tagWorker}" data-patch-worker="${patchWorker}" data-wasm-base="${webview.asWebviewUri(base)}/" data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<header class="toolbar">
  <span class="title" id="title"></span>
  <span class="count" id="count"></span>
  <span class="spacer"></span>
  <label>View
    <select id="mode">
      <option value="flat">All subfolders</option>
      <option value="grouped">Grouped by subfolder</option>
      <option value="folder">This folder only</option>
    </select>
  </label>
  <label>Sort
    <select id="sort">
      <option value="name">Name</option>
      <option value="mtime">Modified</option>
      <option value="size">File size</option>
      <option value="resolution">Resolution</option>
      <option value="aspect">Aspect ratio</option>
    </select>
  </label>
  <button id="dir" title="Toggle ascending / descending"></button>
  <label title="Thumbnail size (Ctrl+wheel)">Size
    <input id="size" type="range" min="64" max="512" step="8">
  </label>
  <button id="refresh" data-icon="refresh" title="Rescan folder">Refresh</button>
  <button id="help" title="Keyboard shortcuts (?)">?</button>
</header>
<div class="scan-bar" id="scanBar" hidden></div>
<div class="toolbar filters">
  <input id="search" type="search" placeholder="Search…  (-word excludes)" title="Every word must be found, in any order; &quot;two words&quot; is one phrase; -word or -&quot;two words&quot; excludes. In Tag scope the text is one tag name." aria-label="Search">
  <select id="scope" aria-label="Search in">
    <option value="any">Name or caption</option>
    <option value="name">File name</option>
    <option value="caption">Caption text</option>
    <option value="tag">Exact tag</option>
  </select>
  <label><input type="checkbox" id="fMissing"> Missing caption</label>
  <label><input type="checkbox" id="fNot8"> Not ÷8</label>
  <label><input type="checkbox" id="fSmall"> Short side &lt; <span id="minRes"></span></label>
  <select id="fQuality" aria-label="Quality filter" title="Show only images with this quality flag"></select>
  <span class="spacer"></span>
  <label title="Show caption text when hovering a tile"><input type="checkbox" id="hoverCaption"> Caption tooltip</label>
  <button id="repeats" data-icon="repeats" title="Kohya repeats: number the subfolders (N_name) so each contributes about the same samples per epoch">Repeats…</button>
  <button id="stats" data-icon="stats" title="Statistics of the selected or visible images: folders and repeats, sizes, buckets, captions, tags">Stats</button>
  <button id="tagTools" data-icon="tags" title="Rename, merge, remove or add tags across the selected or visible images">Tags…</button>
  <button id="dups" data-icon="duplicates" title="Find near-duplicate images by perceptual hash">Duplicates…</button>
  <button id="review" data-icon="review" title="Step through the selected or visible images: keep, delete, skip, edit caption">Review</button>
  <button id="resize" data-icon="resize" title="Resize or crop the selected images, or all visible images when nothing is selected, to buckets or a size">Resize…</button>
  <button id="autoCaption" data-icon="sparkle" title="Generate captions with the WD tagger for the selected images, or all visible images when nothing is selected">Auto-caption…</button>
  <button id="clearSel" data-icon="selNone" title="Clear the selection (Esc)" hidden>Clear selection</button>
  <button id="delete" data-icon="trash" title="Delete selected images and their captions (Delete)" disabled>Delete<span id="deleteCount"></span></button>
</div>
<main id="scroller" tabindex="0" role="grid" aria-multiselectable="true"><div id="spacer"></div><div id="band" hidden></div></main>
<footer class="status"><span id="status"></span><span class="tag-progress"><span id="tagText"></span><button id="tagCancel" hidden>Cancel</button></span><span id="selInfo"></span></footer>
<dialog id="captionDialog" class="leave-dialog">
  <form method="dialog">
    <p id="captionTargets"></p>
    <p><label>Images with a caption
      <select id="captionMode">
        <option value="skip">Skip them</option>
        <option value="append">Append new tags</option>
        <option value="overwrite">Overwrite the caption</option>
      </select>
    </label></p>
    <p class="hint" id="captionModel"></p>
    <div class="dialog-buttons">
      <button value="start" class="primary">Start</button>
      <button value="cancel">Cancel</button>
    </div>
  </form>
</dialog>
<section id="detail" hidden></section>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    GalleryPanel.panels.delete(this.folder.toString());
    if (GalleryPanel.active === this) GalleryPanel.active = undefined;
    clearTimeout(this.debounceTimer);
    clearInterval(this.pollTimer);
    this.dataset.dispose();
    void this.dims.flush();
    for (const d of this.disposables) d.dispose();
  }
}
