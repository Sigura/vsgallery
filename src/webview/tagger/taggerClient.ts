import type { HostToWebview, TaggerModelFiles, WebviewToHost } from '../../shared/protocol';
import { parseSelectedTags, postprocess, resultTags, type ExistingCaptionMode, type TagLabels, type TaggerSettings } from '../../shared/tagger';
import type { TagWorkerRequest, TagWorkerResponse } from './tagWorker';

type HostReply = Extract<HostToWebview, { type: 'taggerModel' | 'captionApplied' }>;
type WorkerJob = { type: 'load'; modelUrl: string; wasmBase: string; backend: TaggerSettings['backend'] } | { type: 'run'; blob: Blob; size: number };

interface Loaded {
  key: string;
  files: TaggerModelFiles;
  labels: TagLabels;
  backend: 'webgpu' | 'wasm';
}

export class CancelledByUser extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** WD tagger running in a module worker; model files come from the extension host. */
export class TaggerClient {
  private worker: Worker | undefined;
  private workerBlobUrl: string | undefined;
  private readonly rpc = new Map<number, { resolve: (r: TagWorkerResponse) => void; reject: (e: unknown) => void }>();
  private readonly hostRpc = new Map<number, (m: HostReply) => void>();
  private nextId = 1;
  private loaded: Loaded | undefined;
  private loading: Promise<Loaded> | undefined;

  constructor(
    private readonly workerUrl: string,
    private readonly wasmBase: string,
    private readonly post: (m: WebviewToHost) => void,
    private readonly settings: () => TaggerSettings,
    private readonly status: (text: string) => void,
  ) {}

  /** Routes the host's replies to tagger requests; returns false for other messages. */
  onHostMessage(m: HostToWebview): boolean {
    if (m.type !== 'taggerModel' && m.type !== 'captionApplied') return false;
    const resolve = this.hostRpc.get(m.requestId);
    this.hostRpc.delete(m.requestId);
    resolve?.(m);
    return true;
  }

  get modelLabel(): string | undefined {
    return this.loaded ? `${this.loaded.files.label} (${this.loaded.backend === 'webgpu' ? 'WebGPU' : 'WebAssembly'})` : undefined;
  }

  /** Loads the model (asking the host to download it first if needed); reuses the loaded one when unchanged. */
  prepare(): Promise<Loaded> {
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  /** Uses the model loaded by the last prepare(); call prepare() first to pick up model changes. */
  async tagBlob(blob: Blob): Promise<string[]> {
    const m = this.loaded ?? (await this.prepare());
    const r = await this.callWorker({ type: 'run', blob, size: m.files.inputSize });
    if (!r.ok || !r.probs) throw new Error(r.ok ? 'No output' : r.error);
    return resultTags(postprocess(r.probs, m.labels, this.settings()));
  }

  async tagUrl(url: string): Promise<string[]> {
    return this.tagBlob(await fetchBlob(url));
  }

  applyCaption(id: string, tags: string[], mode: ExistingCaptionMode): Promise<Extract<HostReply, { type: 'captionApplied' }>> {
    return this.askHost({ type: 'applyCaption', requestId: 0, id, tags, mode }) as Promise<Extract<HostReply, { type: 'captionApplied' }>>;
  }

  private async load(): Promise<Loaded> {
    const s = this.settings();
    this.status('Preparing caption model…');
    const reply = await this.askHost({ type: 'taggerModel', requestId: 0 });
    if (reply.type !== 'taggerModel' || !reply.model) {
      this.status('');
      if (reply.type === 'taggerModel' && reply.cancelled) throw new CancelledByUser();
      throw new Error(reply.type === 'taggerModel' ? (reply.error ?? 'No model') : 'Unexpected reply');
    }
    const files = reply.model;
    const key = `${files.version}|${s.backend}`;
    if (this.loaded?.key === key && this.worker) {
      this.status('');
      return this.loaded;
    }
    this.loaded = undefined;
    try {
      this.status(`Loading ${files.label}…`);
      const labels = parseSelectedTags(await (await fetchBlob(files.tagsUrl)).text());
      const r = await this.callWorker({ type: 'load', modelUrl: files.modelUrl, wasmBase: this.wasmBase, backend: s.backend });
      if (!r.ok || !r.backend) throw new Error(r.ok ? 'No backend' : r.error);
      this.loaded = { key, files, labels, backend: r.backend };
      return this.loaded;
    } finally {
      this.status('');
    }
  }

  private askHost(m: Extract<WebviewToHost, { type: 'taggerModel' | 'applyCaption' }>): Promise<HostReply> {
    const requestId = this.nextId++;
    return new Promise((resolve) => {
      this.hostRpc.set(requestId, resolve);
      this.post({ ...m, requestId });
    });
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!this.workerBlobUrl) {
      // Webview resources are cross-origin for Worker(), so the worker is started from a blob: URL.
      const res = await fetch(this.workerUrl);
      if (!res.ok) throw new Error(`Cannot load the tagger worker: HTTP ${res.status}`);
      this.workerBlobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    }
    const w = new Worker(this.workerBlobUrl, { type: 'module' });
    w.onmessage = (ev: MessageEvent<TagWorkerResponse>) => {
      const p = this.rpc.get(ev.data.id);
      this.rpc.delete(ev.data.id);
      p?.resolve(ev.data);
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      // Typically out of memory while loading a large model; the next request starts a fresh worker.
      this.resetWorker(`Tagger worker crashed${ev.message ? `: ${ev.message}` : ''}`);
    };
    this.worker = w;
    return w;
  }

  private resetWorker(reason: string): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.loaded = undefined;
    const pending = [...this.rpc.values()];
    this.rpc.clear();
    for (const p of pending) p.reject(new Error(reason));
  }

  private async callWorker(job: WorkerJob): Promise<TagWorkerResponse> {
    const w = await this.ensureWorker();
    const req = { ...job, id: this.nextId++ } as TagWorkerRequest;
    return new Promise((resolve, reject) => {
      this.rpc.set(req.id, { resolve, reject });
      w.postMessage(req);
    });
  }
}

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 404 ? 'file not found' : `HTTP ${res.status}`);
  return res.blob();
}
