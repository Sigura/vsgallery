import { inpaint } from '../../../shared/inpaint';

export interface PatchRequest {
  id: number;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  hole: Uint8Array;
}

export type PatchResponse = { id: number; ok: true; rgba: Uint8ClampedArray } | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<PatchRequest>) => void) | null;
  postMessage(msg: PatchResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev) => {
  const { id, rgba, w, h, hole } = ev.data;
  try {
    const out = inpaint(rgba, w, h, hole);
    ctx.postMessage({ id, ok: true, rgba: out }, [out.buffer]);
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
