import './gallery.css';
import { entryComparator, naturalCompare } from '../../shared/naturalSort';
import { folderTag } from '../../shared/kohya';
import { isCaptionEmpty, parseTags } from '../../shared/captions';
import { parseSearch } from '../../shared/search';
import type { GallerySettings, HostToWebview, ImageEntry, SortDir, SortKey, ViewMode, WebviewToHost } from '../../shared/protocol';
import { ThumbLoader } from './thumbLoader';
import { VirtualGrid, type Anchor, type Group } from './virtualGrid';
import { SelectionController } from './selection';
import { DetailView } from '../detail/detailView';
import type { EditorUiState } from '../detail/editor/imageEditor';
import { CancelledByUser, TaggerClient } from '../tagger/taggerClient';
import { AutoCaptionBatch, type BatchProgress } from '../tagger/autoCaption';
import type { ExistingCaptionMode } from '../../shared/tagger';
import { ResizeDialog, type ResizeUiState } from '../resize/resizeDialog';
import { ResizeBatch, type ResizeProgress } from '../resize/resizeBatch';
import { DatasetTools } from './datasetTools';
import { HelpOverlay } from './helpOverlay';
import { DebugPanel } from './debugPanel';
import { applyIcons } from '../icons';
import { matchesQuality, qualityBadges, qualityFilterOptions, type QualityFilter } from './qualityUi';

type SearchScope = 'any' | 'name' | 'caption' | 'tag';

interface UiState {
  folderUri?: string;
  sort: SortKey;
  dir: SortDir;
  mode: ViewMode;
  tileSize?: number;
  anchor?: Anchor;
  search: string;
  scope: SearchScope;
  fMissing: boolean;
  fNot8: boolean;
  fSmall: boolean;
  fQuality: QualityFilter;
  hoverCaption: boolean;
  syncExplorer: boolean;
  resize?: ResizeUiState;
  editor?: Partial<EditorUiState>;
  /** Image open in the detail view, restored after the webview reloads. */
  detailId?: string;
}

declare function acquireVsCodeApi(): {
  postMessage(m: WebviewToHost): void;
  getState(): Partial<UiState> | undefined;
  setState(s: UiState): void;
};

const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Registered before anything else runs, so a crash while the page loads is reported too.
const debug = document.body.dataset.debug === '1' ? new DebugPanel(debugState) : undefined;
window.addEventListener('error', (ev) => {
  debug?.error(`Uncaught: ${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}${ev.error instanceof Error && ev.error.stack ? `\n${ev.error.stack}` : ''}`);
  post({ type: 'error', message: `Uncaught: ${ev.message}` });
});
window.addEventListener('unhandledrejection', (ev) => {
  const r: unknown = ev.reason;
  debug?.error(`Unhandled rejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`);
  post({ type: 'error', message: `Unhandled rejection: ${r}` });
});

const ui: UiState = {
  sort: 'name',
  dir: 'asc',
  mode: 'flat',
  search: '',
  scope: 'any',
  fMissing: false,
  fNot8: false,
  fSmall: false,
  fQuality: '',
  hoverCaption: true,
  syncExplorer: false,
  ...vscode.getState(),
};
let entries = new Map<string, ImageEntry>();
let imageBase = '';
let thumbBase = '';
let scanning = true;
let scanError: string | undefined;
let grid: VirtualGrid | undefined;
let loader: ThumbLoader | undefined;
let highlighted: string | undefined;
// Embedded in the page: the detail view and editor read settings while the script loads, before 'init'.
let settings: GallerySettings = JSON.parse(document.body.dataset.settings!) as GallerySettings;

applyIcons(document.body);
const scroller = $<HTMLElement>('scroller');
const modeSel = $<HTMLSelectElement>('mode');
const sortSel = $<HTMLSelectElement>('sort');
const dirBtn = $<HTMLButtonElement>('dir');
const sizeInput = $<HTMLInputElement>('size');
const searchInput = $<HTMLInputElement>('search');
const scopeSel = $<HTMLSelectElement>('scope');
const deleteBtn = $<HTMLButtonElement>('delete');
const autoCaptionBtn = $<HTMLButtonElement>('autoCaption');
const resizeBtn = $<HTMLButtonElement>('resize');
const tagCancelBtn = $<HTMLButtonElement>('tagCancel');
const captionDialog = $<HTMLDialogElement>('captionDialog');
const modeSelect = $<HTMLSelectElement>('captionMode');
const qualitySel = $<HTMLSelectElement>('fQuality');
qualitySel.innerHTML = qualityFilterOptions();
const checks = {
  fMissing: $<HTMLInputElement>('fMissing'),
  fNot8: $<HTMLInputElement>('fNot8'),
  fSmall: $<HTMLInputElement>('fSmall'),
  hoverCaption: $<HTMLInputElement>('hoverCaption'),
};

const tagger = new TaggerClient(
  document.body.dataset.tagWorker!,
  document.body.dataset.wasmBase!,
  post,
  () => settings!.tagger,
  (text) => {
    if (!batch) setTagText(text);
    detail.taggerStatus(text);
  },
);
let batch: AutoCaptionBatch | ResizeBatch | undefined;
let folderPath = '';

const selection = new SelectionController(
  scroller,
  $('band'),
  () => grid,
  () => selectionChanged(),
  () => deleteSelected(),
  (id) => openDetail(id),
  {
    start: (ids, x, y) => moveDrag.start(ids, x, y),
    move: (x, y) => moveDrag.move(x, y),
    end: (x, y, drop) => moveDrag.end(x, y, drop),
  },
);

const detail = new DetailView($('detail'), {
  entry: (id) => entries.get(id),
  imageUrl: (e) => imageUrl(e),
  previewUrl: (e) => loader?.objectUrl(e.thumb) ?? (e.hasThumb ? thumbUrl(e) : undefined),
  post,
  settings: () => settings!,
  syncExplorer: () => ui.syncExplorer,
  setSyncExplorer: (on) => {
    ui.syncExplorer = on;
    saveState();
  },
  editorState: () => ui.editor,
  saveEditorState: (s) => {
    ui.editor = s;
    saveStateSoon();
  },
  changed: (id) => {
    ui.detailId = id;
    saveState();
  },
  generateTags: async (e) => {
    await tagger.prepare();
    return tagger.tagUrl(imageUrl(e));
  },
  closed: (id) => {
    if (tools.detailClosed()) return;
    if (id && grid?.indexOf(id) !== undefined) {
      selection.selectOnly(id);
      grid.ensureVisible(id);
    }
    scroller.focus({ preventScroll: true });
  },
});

function openDetail(id: string): void {
  if (!entries.has(id)) return;
  detail.open(id, grid ? grid.order.map((e) => e.id) : [id]);
}

// Created before the tools so its "?" key handler runs ahead of the review mode's.
const help = new HelpOverlay();
const tools = new DatasetTools({
  rootName: () => $('title').textContent ?? '',
  entries: () => entries.values(),
  entry: (id) => entries.get(id),
  targets: () => captionTargets(),
  previewUrl: (e) => loader?.objectUrl(e.thumb) ?? (e.hasThumb ? thumbUrl(e) : undefined),
  imageUrl: (e) => imageUrl(e),
  settings: () => settings!,
  post,
  deleteIds: (ids) => post({ type: 'delete', ids }),
  openDetail: (id, order) => {
    if (entries.has(id)) detail.open(id, order);
  },
  captionWritten: (id, text) => captionWritten(id, text),
  analysed: (ids) => {
    for (const id of ids) grid?.refresh(id);
    if (ui.fQuality === 'blur' || ui.fQuality === 'issues') scheduleRebuild(1000);
    updateStatus();
  },
  duplicatesChanged: () => grid?.refreshLive(),
  reviewClosed: (id) => {
    if (id && grid?.indexOf(id) !== undefined) {
      selection.selectOnly(id);
      grid.ensureVisible(id);
    }
    scroller.focus({ preventScroll: true });
  },
  progress: () => updateStatus(),
});

function saveState(): void {
  vscode.setState({ ...ui, anchor: grid?.anchor() ?? ui.anchor });
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveStateSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 250);
}

const encodePath = (id: string) => id.split('/').map(encodeURIComponent).join('/');
const imageUrl = (e: ImageEntry) => `${imageBase}/${encodePath(e.id)}`;
const thumbUrl = (e: ImageEntry) => `${thumbBase}/${e.thumb}.webp`;

const notDiv8 = (e: ImageEntry) => e.w > 0 && (e.w % 8 !== 0 || e.h % 8 !== 0);
const captionMissing = (e: ImageEntry) => e.caption === null || (typeof e.caption === 'string' && isCaptionEmpty(e.caption));

function filtersActive(): boolean {
  return ui.fMissing || ui.fNot8 || ui.fSmall || ui.fQuality !== '' || ui.search.trim() !== '';
}

function matches(e: ImageEntry): boolean {
  if (ui.fMissing && !captionMissing(e)) return false;
  if (ui.fNot8 && !notDiv8(e)) return false;
  if (ui.fSmall && !(e.w > 0 && Math.min(e.w, e.h) < (settings?.minResolution ?? 512))) return false;
  if (settings && !matchesQuality(e, settings, ui.fQuality)) return false;
  const { include, text, exclude } = parseSearch(ui.search);
  if (!include.length && !exclude.length) return true;
  const name = e.id.toLowerCase();
  const caption = typeof e.caption === 'string' ? e.caption.toLowerCase() : '';
  const tags = ui.scope === 'tag' ? parseTags(caption) : [];
  const hit = (q: string): boolean => {
    switch (ui.scope) {
      case 'name':
        return name.includes(q);
      case 'caption':
        return caption.includes(q);
      case 'tag':
        return tags.includes(q);
      case 'any':
        return name.includes(q) || caption.includes(q);
    }
  };
  // In tag scope the remaining text names one tag, so multi-word tags work without quotes.
  if (ui.scope === 'tag') return (!text || hit(text)) && !exclude.some(hit);
  return include.every(hit) && !exclude.some(hit);
}

function buildGroups(): Group[] {
  const cmp = entryComparator(ui.sort, ui.dir);
  let all = [...entries.values()];
  if (ui.mode === 'folder') all = all.filter((e) => e.dir === '');
  if (filtersActive()) all = all.filter(matches);
  if (ui.mode !== 'grouped') return [{ title: null, entries: all.sort(cmp) }];
  const byDir = new Map<string, ImageEntry[]>();
  for (const e of all) {
    let list = byDir.get(e.dir);
    if (!list) byDir.set(e.dir, (list = []));
    list.push(e);
  }
  return [...byDir.keys()]
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : naturalCompare(a, b)))
    .map((dir) => ({ title: dir, entries: byDir.get(dir)!.sort(cmp) }));
}

function rebuild(anchor?: Anchor): void {
  if (!grid) return;
  clearTimeout(rebuildTimer);
  const groups = buildGroups();
  grid.setData(groups, anchor ?? grid.anchor());
  const shown = groups.reduce((n, g) => n + g.entries.length, 0);
  debug?.log(`rebuild: ${shown} shown of ${entries.size}, ${groups.length} group(s), ${grid.debugInfo()}`);
  $('count').textContent = shown === entries.size ? `${shown} images` : `${shown} of ${entries.size} images`;
  // Selection only covers what is visible, so actions never touch filtered-out images.
  selection.prune((id) => grid!.indexOf(id) !== undefined);
  updateStatus();
}

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRebuild(delay = 300): void {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(), delay);
}

let statusFrame = 0;
function updateStatus(): void {
  if (statusFrame) return;
  statusFrame = requestAnimationFrame(() => {
    statusFrame = 0;
    const parts: string[] = [];
    if (scanError) parts.push(scanError);
    if (scanning) parts.push(`Scanning… ${entries.size} found`);
    $('scanBar').hidden = !scanning;
    let unknown = 0;
    let missing = 0;
    for (const e of entries.values()) {
      if (e.w === 0) unknown++;
      if (captionMissing(e)) missing++;
    }
    if (missing) parts.push(`${missing} without caption`);
    if (unknown) parts.push(`${unknown} without known size`);
    const busy = loader?.busy ?? 0;
    if (busy) parts.push(`Generating thumbnails: ${busy} queued`);
    const failed = loader?.failedCount ?? 0;
    if (failed) parts.push(`${failed} thumbnail(s) failed (Refresh to retry)`);
    const analysis = tools.statusText();
    if (analysis) parts.push(analysis);
    $('status').textContent = parts.join(' · ');
  });
}

function selectionChanged(): void {
  grid?.refreshLive();
  const n = selection.selected.size;
  $('selInfo').textContent = n ? `${n} selected` : '';
  $('clearSel').hidden = n === 0;
  deleteBtn.disabled = n === 0;
  $('deleteCount').textContent = n ? ` ${n}` : '';
  // With a selection, every tile shows its checkbox so more can be ticked without Ctrl.
  scroller.classList.toggle('has-selection', n > 0);
  post({ type: 'selection', ids: [...selection.selected] });
}

let tagTextTimer: ReturnType<typeof setTimeout> | undefined;
function setTagText(text: string, clearAfterMs?: number): void {
  clearTimeout(tagTextTimer);
  $('tagText').textContent = text;
  if (clearAfterMs) tagTextTimer = setTimeout(() => ($('tagText').textContent = ''), clearAfterMs);
}

function captionWritten(id: string, text: string): void {
  const e = entries.get(id);
  if (!e) return;
  e.caption = text;
  detail.onPatch({ id, caption: text });
  tools.entryChanged(id);
  grid?.refresh(id);
  if (ui.fMissing || ui.fQuality || ui.search.trim()) scheduleRebuild();
  updateStatus();
}

function batchSummary(p: BatchProgress): string {
  const parts = [`${p.written} written`];
  if (p.skipped) parts.push(`${p.skipped} skipped`);
  if (p.failed) parts.push(`${p.failed} failed (see Output › LoRA Dataset Studio)`);
  return parts.join(', ');
}

/** Selected images, or all visible ones when nothing is selected, in gallery order. */
function captionTargets(): { ids: string[]; what: string } {
  const visible = grid ? grid.order.map((e) => e.id) : [];
  if (selection.selected.size) {
    const ids = visible.filter((id) => selection.selected.has(id));
    return { ids, what: `${ids.length} selected image${ids.length === 1 ? '' : 's'}` };
  }
  return { ids: visible, what: `all ${visible.length} visible image${visible.length === 1 ? '' : 's'}` };
}

function openAutoCaption(): void {
  if (batch || detail.isOpen || !settings || resizeDialog.isOpen || tools.isOpen) return;
  const { ids, what } = captionTargets();
  if (!ids.length) return;
  const t = settings.tagger;
  $('captionTargets').textContent = `Generate captions for ${what}.`;
  modeSelect.value = t.existingCaptions;
  const model = t.modelFolder.trim() || t.model;
  $('captionModel').textContent =
    `Model: ${model} · thresholds ${t.generalThreshold} / ${t.characterThreshold} (character)` +
    (t.triggerWord.trim() ? ` · trigger word: ${t.triggerWord.trim()}` : '') +
    ' · change in Settings › LoRA Dataset.';
  captionDialog.returnValue = '';
  captionDialog.showModal();
  captionDialog.addEventListener(
    'close',
    () => {
      if (captionDialog.returnValue === 'start') void runAutoCaption(ids, modeSelect.value as ExistingCaptionMode);
    },
    { once: true },
  );
}

async function runAutoCaption(ids: string[], mode: ExistingCaptionMode): Promise<void> {
  const b = new AutoCaptionBatch(tagger, ids, mode, {
    entry: (id) => entries.get(id),
    imageUrl: (e) => imageUrl(e),
    captionWritten,
    progress: (p) => setTagText(`Auto-caption: ${p.done} / ${p.total}${b.isCancelled ? ' (stopping…)' : ''}`),
    error: (message) => post({ type: 'error', message }),
  });
  batch = b;
  setBusy(true);
  try {
    const p = await b.run();
    setTagText(`Auto-caption ${b.isCancelled ? 'cancelled' : 'done'}: ${batchSummary(p)}`, p.failed ? undefined : 20000);
  } catch (e) {
    const msg = e instanceof CancelledByUser ? 'model download cancelled' : e instanceof Error ? e.message : String(e);
    setTagText(`Auto-caption stopped: ${msg}${b.progress.done ? ` (${batchSummary(b.progress)})` : ''}`);
    if (!(e instanceof CancelledByUser)) post({ type: 'error', message: `Auto-caption: ${msg}` });
  } finally {
    batch = undefined;
    setBusy(false);
  }
}

function setBusy(busy: boolean): void {
  autoCaptionBtn.disabled = busy;
  resizeBtn.disabled = busy;
  tagCancelBtn.hidden = !busy;
}

const resizeDialog = new ResizeDialog(
  {
    entry: (id) => entries.get(id),
    previewUrl: (e) => loader?.objectUrl(e.thumb) ?? (e.hasThumb ? thumbUrl(e) : undefined),
    folderPath: () => folderPath,
    editorBackup: () => settings.editorBackup,
    saveState: (s) => {
      ui.resize = s;
      saveStateSoon();
    },
  },
  ui.resize ?? { mode: 'bucket', bucketBase: 1024, size: 1024, snap: 8, upscale: false, output: 'folder' },
);

function resizeSummary(p: ResizeProgress): string {
  const parts = [`${p.written} written`];
  if (p.skipped) parts.push(`${p.skipped} unchanged/skipped`);
  if (p.failed) parts.push(`${p.failed} failed (see Output › LoRA Dataset Studio)`);
  return parts.join(', ');
}

async function openResize(): Promise<void> {
  if (batch || detail.isOpen || !settings || captionDialog.open || resizeDialog.isOpen || tools.isOpen) return;
  const { ids, what } = captionTargets();
  if (!ids.length) return;
  const choice = await resizeDialog.open(ids, what);
  if (!choice || batch) return;
  const b = new ResizeBatch(ids, choice.opts, choice.output, {
    entry: (id) => entries.get(id),
    imageUrl: (e) => imageUrl(e),
    post,
    quality: () => settings?.jpegQuality ?? 0.95,
    progress: (p) => setTagText(`Resize: ${p.done} / ${p.total}${b.isCancelled ? ' (stopping…)' : ''}`),
    error: (message) => post({ type: 'error', message }),
  });
  batch = b;
  setBusy(true);
  try {
    const p = await b.run();
    setTagText(`Resize ${b.isCancelled ? 'cancelled' : 'done'}: ${resizeSummary(p)}`, p.failed ? undefined : 20000);
  } finally {
    batch = undefined;
    setBusy(false);
  }
}

function deleteSelected(): void {
  if (selection.selected.size) post({ type: 'delete', ids: [...selection.selected] });
}

function createTile(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tile';
  el.setAttribute('role', 'gridcell');
  el.innerHTML =
    '<div class="thumb"><img draggable="false" alt=""><span class="placeholder"></span><div class="badges"></div>' +
    '<span class="tile-check" title="Select (Ctrl+click)"></span></div>' +
    '<div class="meta"><div class="name"></div><div class="sub"><span class="res"></span><span class="tag"></span></div></div>';
  const img = el.querySelector('img')!;
  img.addEventListener('load', () => el.classList.add('loaded'));
  img.addEventListener('error', () => {
    const id = el.dataset.id;
    const e = id ? entries.get(id) : undefined;
    // A cached thumbnail can vanish (cache cleared/pruned); fall back to regenerating it.
    if (e && e.hasThumb && img.src === thumbUrl(e)) {
      e.hasThumb = false;
      grid?.refresh(e.id);
    }
  });
  return el;
}

function badge(parent: HTMLElement, text: string, cls: string, title: string): void {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  b.title = title;
  parent.appendChild(b);
}

function bindTile(el: HTMLElement, e: ImageEntry): void {
  const changed = el.dataset.id !== e.id;
  el.dataset.id = e.id;
  // Passed to context-menu commands, which act on the tile that was right-clicked.
  el.dataset.vscodeContext = JSON.stringify({ webviewSection: 'tile', imageId: e.id });
  const selected = selection.selected.has(e.id);
  el.setAttribute('aria-selected', String(selected));
  el.classList.toggle('selected', selected);
  el.classList.toggle('focused', selection.focus === e.id);
  el.classList.toggle('highlight', e.id === highlighted);
  el.querySelector('.name')!.textContent = e.name;
  el.querySelector('.res')!.textContent = e.w ? `${e.w}×${e.h}` : '…';
  const tag = el.querySelector<HTMLElement>('.tag')!;
  tag.textContent = ui.mode === 'flat' ? folderTag(e.dir) : '';
  tag.hidden = !tag.textContent;

  const caption = typeof e.caption === 'string' ? e.caption.trim() : '';
  el.title = ui.hoverCaption && caption ? (caption.length > 600 ? `${caption.slice(0, 600)}…` : caption) : e.id;

  const badges = el.querySelector<HTMLElement>('.badges')!;
  badges.replaceChildren();
  if (settings) for (const b of qualityBadges(e, settings)) badge(badges, b.text, b.cls, b.title);
  if (tools.isDuplicate(e.id)) badge(badges, 'duplicate', 'info', 'In a near-duplicate group (Duplicates…)');

  const img = el.querySelector('img')!;
  const src = loader?.objectUrl(e.thumb) ?? (e.hasThumb ? thumbUrl(e) : '');
  const failure = loader?.failure(e.thumb);
  el.classList.toggle('failed', failure !== undefined);
  el.querySelector('.placeholder')!.textContent = failure ?? '';
  if (changed || img.getAttribute('src') !== src) {
    el.classList.remove('loaded');
    if (src) img.src = src;
    else img.removeAttribute('src');
  }
}

function createHeader(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'group-header';
  el.innerHTML = '<span class="label"></span><span class="path"></span><span class="n"></span>';
  return el;
}

function bindHeader(el: HTMLElement, g: Group): void {
  el.dataset.dir = g.title ?? '';
  el.querySelector('.label')!.textContent = g.title ? folderTag(g.title) : '(root)';
  el.querySelector('.path')!.textContent = g.title && g.title !== folderTag(g.title) ? g.title : '';
  el.querySelector('.n')!.textContent = `${g.entries.length}`;
}

function visibleChanged(inView: ImageEntry[], overscan: ImageEntry[]): void {
  if (!loader) return;
  const keep = new Set<string>();
  const want = (e: ImageEntry, priority: number) => {
    if (e.hasThumb || loader!.objectUrl(e.thumb)) return;
    keep.add(e.thumb);
    loader!.request(e, imageUrl(e), priority);
  };
  inView.forEach((e, i) => want(e, i));
  overscan.forEach((e, i) => want(e, 100000 + i));
  loader.retain(keep);
  updateStatus();
  saveStateSoon();
}

function reveal(id: string): void {
  highlighted = id;
  if (!grid?.scrollToId(id)) return;
  grid.refresh(id);
}

function setTileSize(size: number): void {
  const s = Math.max(64, Math.min(512, Math.round(size)));
  ui.tileSize = s;
  sizeInput.value = String(s);
  grid?.setTileSize(s);
  saveStateSoon();
}

function applySettings(s: GallerySettings): void {
  settings = s;
  $('minRes').textContent = String(s.minResolution);
}

async function init(m: Extract<HostToWebview, { type: 'init' }>): Promise<void> {
  debug?.log(`init: ${m.entries.length} entries, scanning=${m.scanning}${m.error ? `, error=${m.error}` : ''}, reveal=${m.reveal ?? '-'}`);
  ui.folderUri = m.folderUri;
  folderPath = m.folderPath;
  imageBase = m.imageBase;
  thumbBase = m.thumbBase;
  applySettings(m.settings);
  scanning = m.scanning;
  scanError = m.error;
  $('title').textContent = m.folderName;
  entries = new Map(m.entries.map((e) => [e.id, e]));
  loader ??= await ThumbLoader.create(
    document.body.dataset.worker!,
    m.settings.concurrency,
    m.settings.thumbnailResolution,
    post,
    (id) => {
      grid?.refresh(id);
      updateStatus();
    },
  );
  debug?.log('init: thumbnail loader ready');
  tools.start(document.body.dataset.analysisWorker!).catch((e: unknown) => post({ type: 'error', message: `Image analysis unavailable: ${e}` }));
  const size = ui.tileSize ?? m.settings.thumbnailSize;
  sizeInput.value = String(size);
  ui.tileSize = size;
  grid ??= new VirtualGrid(scroller, $('spacer'), { createTile, bindTile, createHeader, bindHeader, visibleChanged }, size);
  rebuild(m.reveal ? undefined : ui.anchor);
  if (m.reveal) reveal(m.reveal);
  const openId = m.reveal && m.open ? m.reveal : ui.detailId;
  if (openId && entries.has(openId)) openDetail(openId);
  saveState();
}

let initialized = false;
/** Messages that arrive while init is still running; they are newer than its snapshot. */
let queued: Exclude<HostToWebview, { type: 'init' }>[] | undefined;

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  if (m.type === 'debug') {
    for (const line of m.lines) debug?.log(line, 'host');
    if (m.error) debug?.show(true);
    return;
  }
  if (debug && m.type !== 'thumbSaved') {
    const fate = m.type === 'init' ? '' : queued ? ' (queued, init running)' : initialized ? '' : ' (dropped, before init)';
    debug.log(`message ${describeMessage(m)}${fate}`);
  }
  if (tagger.onHostMessage(m) || tools.onHostMessage(m)) return;
  if (m.type === 'init') {
    initialized = false;
    queued = [];
    init(m).then(
      () => {
        debug?.log(`init done, replaying ${queued?.length ?? 0} queued message(s)`);
        initialized = true;
        const pending = queued ?? [];
        queued = undefined;
        for (const q of pending) onHostMessage(q);
      },
      (e) => {
        debug?.error(`init FAILED: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
        post({ type: 'error', message: `init failed: ${e}` });
      },
    );
    return;
  }
  if (queued) {
    queued.push(m);
    return;
  }
  // Anything before init is already contained in the init snapshot.
  if (!initialized) return;
  onHostMessage(m);
});

function onHostMessage(m: Exclude<HostToWebview, { type: 'init' }>): void {
  switch (m.type) {
    case 'delta':
      for (const id of m.removed) entries.delete(id);
      for (const e of m.upserts) entries.set(e.id, e);
      scheduleRebuild(50);
      detail.onEntriesChanged(m.upserts, m.removed);
      tools.entriesChanged(m.upserts, m.removed);
      return;
    case 'patch': {
      let affectsView = false;
      for (const p of m.patches) {
        const e = entries.get(p.id);
        if (!e) continue;
        if (p.w !== undefined && p.h !== undefined) {
          e.w = p.w;
          e.h = p.h;
          affectsView ||= ui.sort === 'resolution' || ui.sort === 'aspect' || ui.fNot8 || ui.fSmall || ui.fQuality !== '';
        }
        if (p.caption !== undefined) {
          e.caption = p.caption;
          affectsView ||= ui.fMissing || ui.fQuality !== '' || ui.search.trim() !== '';
        }
        grid?.refresh(e.id);
        tools.entryChanged(e.id);
        detail.onPatch(p);
      }
      if (affectsView) scheduleRebuild();
      updateStatus();
      return;
    }
    case 'status':
      scanning = m.scanning;
      scanError = m.error;
      updateStatus();
      return;
    case 'thumbSaved': {
      const e = entries.get(m.id);
      if (e && e.thumb === m.key) e.hasThumb = true;
      return;
    }
    case 'settings':
      applySettings(m.settings);
      loader?.setConcurrency(m.settings.concurrency);
      if (loader) loader.resolution = m.settings.thumbnailResolution;
      if (ui.fSmall || ui.fQuality) rebuild();
      else grid?.refreshLive();
      return;
    case 'reveal':
      if (m.open) openDetail(m.id);
      else reveal(m.id);
      return;
    case 'captionSaved': {
      const e = entries.get(m.id);
      if (e && !m.error) {
        e.caption = m.text;
        grid?.refresh(m.id);
        tools.entryChanged(m.id);
        if (ui.fMissing || ui.fQuality || ui.search.trim()) scheduleRebuild();
      }
      detail.onCaptionSaved(m.id, m.text, m.error);
      return;
    }
    case 'imageSaved':
      detail.onImageSaved(m.id, m.mode, m.newId, m.error);
      return;
    case 'autoCaption':
      openAutoCaption();
      return;
    case 'resizeWritten':
      if (batch instanceof ResizeBatch) batch.onHostMessage(m);
      return;
  }
}

function syncControls(): void {
  modeSel.value = ui.mode;
  sortSel.value = ui.sort;
  dirBtn.textContent = ui.dir === 'asc' ? '↑ Asc' : '↓ Desc';
  searchInput.value = ui.search;
  scopeSel.value = ui.scope;
  qualitySel.value = ui.fQuality;
  for (const [k, el] of Object.entries(checks)) el.checked = ui[k as keyof typeof checks];
}

function onViewChange(): void {
  rebuild();
  saveState();
}

modeSel.addEventListener('change', () => {
  ui.mode = modeSel.value as ViewMode;
  onViewChange();
});
sortSel.addEventListener('change', () => {
  ui.sort = sortSel.value as SortKey;
  onViewChange();
});
dirBtn.addEventListener('click', () => {
  ui.dir = ui.dir === 'asc' ? 'desc' : 'asc';
  syncControls();
  onViewChange();
});
let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    ui.search = searchInput.value;
    onViewChange();
  }, 150);
});
scopeSel.addEventListener('change', () => {
  ui.scope = scopeSel.value as SearchScope;
  onViewChange();
});
qualitySel.addEventListener('change', () => {
  ui.fQuality = qualitySel.value as QualityFilter;
  onViewChange();
});
$('help').addEventListener('click', () => help.open());
$('stats').addEventListener('click', () => !detail.isOpen && tools.openStats());
$('repeats').addEventListener('click', () => !detail.isOpen && tools.openBalance());
$('tagTools').addEventListener('click', () => !detail.isOpen && !batch && tools.openTags());
$('dups').addEventListener('click', () => !detail.isOpen && tools.openDuplicates());
$('review').addEventListener('click', () => !detail.isOpen && tools.openReview());
for (const [k, el] of Object.entries(checks)) {
  el.addEventListener('change', () => {
    ui[k as keyof typeof checks] = el.checked;
    if (k === 'hoverCaption') {
      grid?.refreshLive();
      saveState();
    } else onViewChange();
  });
}
deleteBtn.addEventListener('click', deleteSelected);
$('clearSel').addEventListener('click', () => selection.clear());
autoCaptionBtn.addEventListener('click', openAutoCaption);
resizeBtn.addEventListener('click', () => void openResize());
tagCancelBtn.addEventListener('click', () => {
  batch?.cancel();
  setTagText(`${batch instanceof ResizeBatch ? 'Resize' : 'Auto-caption'}: stopping after the current image…`);
});

sizeInput.addEventListener('input', () => setTileSize(Number(sizeInput.value)));
$('refresh').addEventListener('click', () => {
  loader?.resetFailures();
  tools.resetFailures();
  if (initialized) tools.start(document.body.dataset.analysisWorker!).catch((e: unknown) => post({ type: 'error', message: `Image analysis unavailable: ${e}` }));
  post({ type: 'refresh' });
});
scroller.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setTileSize((ui.tileSize ?? 160) * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);


syncControls();
post({ type: 'ready' });

function describeMessage(m: HostToWebview): string {
  switch (m.type) {
    case 'init':
      return `init (${m.entries.length} entries)`;
    case 'delta':
      return `delta +${m.upserts.length} -${m.removed.length}`;
    case 'patch':
      return `patch ${m.patches.length}`;
    case 'status':
      return `status scanning=${m.scanning}${m.error ? ` error=${m.error}` : ''}`;
    default:
      return m.type;
  }
}

function debugState(): string {
  const filtered = filtersActive() ? ` filters=on search="${ui.search}" scope=${ui.scope} missing=${ui.fMissing} not8=${ui.fNot8} small=${ui.fSmall} quality=${ui.fQuality || '-'}` : ' filters=off';
  return [
    `initialized=${initialized} queued=${queued?.length ?? '-'} scanning=${scanning} error=${scanError ?? '-'}`,
    `entries=${entries.size} rootEntries=${[...entries.values()].filter((e) => e.dir === '').length} mode=${ui.mode} sort=${ui.sort}/${ui.dir}${filtered}`,
    `grid: ${grid?.debugInfo() ?? 'not created'}`,
    `thumbs: loader=${loader ? `busy=${loader.busy} failed=${loader.failedCount}` : 'not created'} detail=${ui.detailId ?? '-'}`,
    `window=${innerWidth}x${innerHeight} visible=${document.visibilityState} imageBase=${imageBase || '-'}`,
  ].join('\n');
}

/**
 * Drag of selected tiles: shows the dataset's folders as drop targets (group headers in grouped
 * view work too) and asks the host to move the images with their captions into the chosen one.
 */
const moveDrag = (() => {
  const bar = document.createElement('div');
  bar.className = 'move-bar';
  bar.hidden = true;
  const ghost = document.createElement('div');
  ghost.className = 'move-ghost';
  ghost.hidden = true;
  document.body.append(bar, ghost);
  let ids: string[] = [];
  let target: HTMLElement | undefined;

  const targetAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('.move-chip, .group-header') ?? undefined;

  const setTarget = (t: HTMLElement | undefined) => {
    if (t === target) return;
    target?.classList.remove('drop-target');
    target = t;
    target?.classList.add('drop-target');
  };

  return {
    start(selected: string[], x: number, y: number): void {
      ids = selected;
      const dirs = [...new Set([...entries.values()].map((e) => e.dir))].sort((a, b) =>
        a === '' ? -1 : b === '' ? 1 : naturalCompare(a, b),
      );
      bar.replaceChildren(
        Object.assign(document.createElement('span'), { className: 'move-title', textContent: 'Move to:' }),
        ...dirs.map((d) => {
          const chip = document.createElement('span');
          chip.className = 'move-chip';
          chip.dataset.dir = d;
          chip.textContent = d || '(root)';
          return chip;
        }),
      );
      const r = scroller.getBoundingClientRect();
      bar.style.top = `${r.top}px`;
      bar.hidden = false;
      ghost.textContent = `Move ${ids.length} image(s)`;
      ghost.hidden = false;
      this.move(x, y);
    },
    move(x: number, y: number): void {
      ghost.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
      setTarget(targetAt(x, y));
    },
    end(x: number, y: number, drop: boolean): void {
      const t = drop ? targetAt(x, y) : undefined;
      setTarget(undefined);
      bar.hidden = true;
      ghost.hidden = true;
      if (t?.dataset.dir !== undefined && ids.length) post({ type: 'moveImages', ids, dir: t.dataset.dir });
      ids = [];
    },
  };
})();
