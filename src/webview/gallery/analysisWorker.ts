import { dHash, pHash, sharpness, toGray } from '../../shared/imageHash';
import type { ImageMetrics } from '../../shared/protocol';

const ANALYSIS_SIZE = 256;

export interface AnalysisRequest {
  id: number;
  blob: Blob;
}

export type AnalysisResponse = { id: number; ok: true; metrics: ImageMetrics } | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage(msg: AnalysisResponse): void;
};

async function analyze(blob: Blob): Promise<ImageMetrics> {
  const full = await createImageBitmap(blob);
  // Fixed working size, so the blur metric is comparable between thumbnails and originals.
  const s = ANALYSIS_SIZE / Math.max(full.width, full.height);
  const w = Math.max(1, Math.round(full.width * s));
  const h = Math.max(1, Math.round(full.height * s));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('OffscreenCanvas 2d context unavailable');
  g.imageSmoothingQuality = 'high';
  g.drawImage(full, 0, 0, w, h);
  full.close();
  const gray = toGray(g.getImageData(0, 0, w, h).data, w, h);
  return { dhash: dHash(gray), phash: pHash(gray), sharpness: Math.round(sharpness(gray) * 10) / 10 };
}

ctx.onmessage = (ev) => {
  const { id, blob } = ev.data;
  analyze(blob).then(
    (metrics) => ctx.postMessage({ id, ok: true, metrics }),
    (e: unknown) => ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
};
