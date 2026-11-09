/** Perceptual hashes, near-duplicate grouping and a blur metric on grayscale pixel buffers. */

export interface Gray {
  w: number;
  h: number;
  /** Luma 0..255, row-major. */
  data: Float32Array;
}

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return { w, h, data };
}

/** Box-filter resample: each output pixel is the area-weighted mean of the source pixels it covers. */
export function resizeGray(src: Gray, tw: number, th: number): Gray {
  const out = new Float32Array(tw * th);
  const sx = src.w / tw;
  const sy = src.h / th;
  for (let y = 0; y < th; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < tw; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let sum = 0;
      let area = 0;
      for (let yy = Math.floor(y0); yy < Math.min(src.h, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.min(src.w, Math.ceil(x1)); xx++) {
          const wgt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
          sum += src.data[yy * src.w + xx] * wgt;
          area += wgt;
        }
      }
      out[y * tw + x] = area ? sum / area : 0;
    }
  }
  return { w: tw, h: th, data: out };
}

function bitsToHex(bits: readonly boolean[]): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((+bits[i] << 3) | (+bits[i + 1] << 2) | (+bits[i + 2] << 1) | +bits[i + 3]).toString(16);
  }
  return hex;
}

/** 64-bit difference hash: 9×8 thumbnail, one bit per horizontal neighbour comparison. */
export function dHash(g: Gray): string {
  const s = resizeGray(g, 9, 8).data;
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(s[y * 9 + x] < s[y * 9 + x + 1]);
  return bitsToHex(bits);
}

const N = 32;
const DCT = (() => {
  const m = new Float64Array(N * N);
  for (let k = 0; k < N; k++) {
    for (let n = 0; n < N; n++) m[k * N + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
  }
  return m;
})();

/** 64-bit DCT hash: low 8×8 frequencies of a 32×32 thumbnail (DC term excluded) against their median. */
export function pHash(g: Gray): string {
  const s = resizeGray(g, N, N).data;
  const rows = new Float64Array(8 * N);
  for (let k = 0; k < 8; k++) {
    for (let y = 0; y < N; y++) {
      let sum = 0;
      for (let x = 0; x < N; x++) sum += DCT[k * N + x] * s[y * N + x];
      rows[k * N + y] = sum;
    }
  }
  const coef: number[] = [];
  for (let ky = 0; ky < 8; ky++) {
    for (let kx = 0; kx < 8; kx++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += DCT[ky * N + y] * rows[kx * N + y];
      coef.push(sum);
    }
  }
  const ac = coef.slice(1).sort((a, b) => a - b);
  const median = (ac[31] + ac[32]) / 2;
  return bitsToHex(coef.map((c, i) => i > 0 && c > median));
}

function popcount32(v: number): number {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function words(hex: string): [number, number] {
  return [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];
}

/** Number of differing bits between two 64-bit hex hashes. */
export function hamming(a: string, b: string): number {
  const [a0, a1] = words(a);
  const [b0, b1] = words(b);
  return popcount32(a0 ^ b0) + popcount32(a1 ^ b1);
}

/**
 * Near-duplicate groups: items are linked when their hashes differ in at most `threshold` bits,
 * and groups are the connected components with two or more members, in input order.
 */
export function groupByHash(items: readonly { id: string; hash: string }[], threshold: number): string[][] {
  const n = items.length;
  const hi = new Uint32Array(n);
  const lo = new Uint32Array(n);
  items.forEach((it, i) => ([hi[i], lo[i]] = words(it.hash)));
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (popcount32(hi[i] ^ hi[j]) + popcount32(lo[i] ^ lo[j]) > threshold) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(items[i].id);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Variance of the 4-neighbour Laplacian; low values mean few edges, i.e. a blurry image. */
export function laplacianVariance(g: Gray): number {
  const { w, h, data } = g;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      sum += v;
      sq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}
