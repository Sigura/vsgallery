import * as ort from 'onnxruntime-web';
import { squarePlacement, toModelInput, type TaggerBackend } from '../../shared/tagger';

export type TagWorkerRequest =
  | { type: 'load'; id: number; modelUrl: string; wasmBase: string; backend: TaggerBackend }
  | { type: 'run'; id: number; blob: Blob; size: number };

export type TagWorkerResponse =
  | { id: number; ok: true; backend?: 'webgpu' | 'wasm'; probs?: Float32Array }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<TagWorkerRequest>) => void) | null;
  postMessage(msg: TagWorkerResponse, transfer?: Transferable[]): void;
};

let session: ort.InferenceSession | undefined;

async function create(model: Uint8Array, ep: 'webgpu' | 'wasm'): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all' });
}

async function load(req: Extract<TagWorkerRequest, { type: 'load' }>): Promise<'webgpu' | 'wasm'> {
  ort.env.wasm.wasmPaths = req.wasmBase;
  // Webviews are not cross-origin isolated: no SharedArrayBuffer, so no wasm threads.
  ort.env.wasm.numThreads = 1;
  await session?.release();
  session = undefined;
  const res = await fetch(req.modelUrl);
  if (!res.ok) throw new Error(`Cannot read the model file: HTTP ${res.status}`);
  const model = new Uint8Array(await res.arrayBuffer());
  const gpu = 'gpu' in navigator;
  if (req.backend === 'wasm' || (req.backend === 'auto' && !gpu)) {
    session = await create(model, 'wasm');
    return 'wasm';
  }
  try {
    session = await create(model, 'webgpu');
    return 'webgpu';
  } catch (e) {
    if (req.backend === 'webgpu') throw e;
    console.warn(`WebGPU session failed, using WebAssembly: ${e instanceof Error ? e.message : e}`);
    session = await create(model, 'wasm');
    return 'wasm';
  }
}

async function preprocess(blob: Blob, size: number): Promise<Float32Array> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('OffscreenCanvas 2d context unavailable');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const p = squarePlacement(bitmap.width, bitmap.height, size);
  g.drawImage(bitmap, p.x, p.y, p.w, p.h);
  bitmap.close();
  return toModelInput(g.getImageData(0, 0, size, size).data, size);
}

async function run(req: Extract<TagWorkerRequest, { type: 'run' }>): Promise<Float32Array> {
  if (!session) throw new Error('Model not loaded');
  const input = new ort.Tensor('float32', await preprocess(req.blob, req.size), [1, req.size, req.size, 3]);
  const out = await session.run({ [session.inputNames[0]]: input });
  const t = out[session.outputNames[0]];
  // A copy: the tensor's array may share its buffer, which must not be transferred.
  const data = Float32Array.from((await t.getData()) as Float32Array);
  input.dispose();
  for (const v of Object.values(out)) v.dispose();
  return data;
}

// Requests are handled one at a time: a session must not run concurrently with itself or a reload.
let chain: Promise<unknown> = Promise.resolve();

ctx.onmessage = (ev) => {
  const req = ev.data;
  const fail = (e: unknown) => ctx.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  chain = chain.then(() =>
    req.type === 'load'
      ? load(req).then((backend) => ctx.postMessage({ id: req.id, ok: true, backend }), fail)
      : run(req).then((probs) => ctx.postMessage({ id: req.id, ok: true, probs }, [probs.buffer]), fail),
  );
};
