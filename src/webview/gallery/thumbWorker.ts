export interface ThumbRequest {
  id: number;
  blob: Blob;
  maxSide: number;
  /** Header dimensions if known (0 otherwise); lets the decoder downscale while decoding. */
  w: number;
  h: number;
}

export type ThumbResponse =
  | { id: number; ok: true; data: ArrayBuffer; w: number; h: number }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<ThumbRequest>) => void) | null;
  postMessage(msg: ThumbResponse, transfer?: Transferable[]): void;
};

async function makeThumb({ blob, maxSide, w, h }: ThumbRequest): Promise<{ data: ArrayBuffer; w: number; h: number }> {
  let bitmap: ImageBitmap;
  let srcW = 0;
  let srcH = 0;
  if (w > 0 && h > 0) {
    // Only the long side is given so a rotated EXIF orientation cannot distort the result.
    const opts: ImageBitmapOptions = { resizeQuality: 'high' };
    if (Math.max(w, h) > maxSide) {
      if (w >= h) opts.resizeWidth = maxSide;
      else opts.resizeHeight = maxSide;
    }
    bitmap = await createImageBitmap(blob, opts);
  } else {
    const full = await createImageBitmap(blob);
    srcW = full.width;
    srcH = full.height;
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    bitmap =
      scale < 1
        ? await createImageBitmap(full, {
            resizeWidth: Math.max(1, Math.round(srcW * scale)),
            resizeHeight: Math.max(1, Math.round(srcH * scale)),
            resizeQuality: 'high',
          })
        : full;
    if (bitmap !== full) full.close();
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('OffscreenCanvas 2d context unavailable');
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  return { data: await out.arrayBuffer(), w: srcW, h: srcH };
}

ctx.onmessage = (ev) => {
  const req = ev.data;
  makeThumb(req).then(
    (r) => ctx.postMessage({ id: req.id, ok: true, ...r }, [r.data]),
    (e: unknown) => ctx.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
};
