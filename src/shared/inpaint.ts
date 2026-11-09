/**
 * Exemplar-based inpainting (multi-scale PatchMatch with patch voting, after Wexler et al. 2007):
 * hole pixels are rebuilt from patches found elsewhere in the image, coarse to fine.
 */

export interface InpaintOptions {
  /** Patch radius; patches are (2r+1)². */
  patchRadius?: number;
  seed?: number;
}

interface Level {
  w: number;
  h: number;
  /** RGBA as floats. */
  img: Float32Array;
  hole: Uint8Array;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Summed-area table of the hole mask, (w+1)×(h+1). */
function holeIntegral(l: Level): Int32Array {
  const { w, h, hole } = l;
  const s = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hole[y * w + x];
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
    }
  }
  return s;
}

function holesIn(s: Int32Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  const W = w + 1;
  return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
}

function holeExtent(l: Level): number {
  let x0 = l.w;
  let y0 = l.h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < l.hole.length; i++) {
    if (!l.hole[i]) continue;
    const x = i % l.w;
    const y = (i - x) / l.w;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return x1 < 0 ? 0 : Math.max(x1 - x0, y1 - y0) + 1;
}

function downsample(l: Level): Level {
  const w = Math.ceil(l.w / 2);
  const h = Math.ceil(l.h / 2);
  const img = new Float32Array(w * h * 4);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let anyHole = 0;
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const fx = 2 * x + dx;
          const fy = 2 * y + dy;
          if (fx >= l.w || fy >= l.h) continue;
          const i = fy * l.w + fx;
          if (l.hole[i]) {
            anyHole = 1;
            continue;
          }
          for (let c = 0; c < 4; c++) acc[c] += l.img[i * 4 + c];
          n++;
        }
      }
      const o = y * w + x;
      // Conservative: a coarse pixel touching the hole is hole, so coarse sources are clean.
      hole[o] = anyHole;
      if (n) for (let c = 0; c < 4; c++) img[o * 4 + c] = acc[c] / n;
    }
  }
  return { w, h, img, hole };
}

/** Fills hole pixels layer by layer from the average of their known 8-neighbours. */
function diffuseFill(l: Level): void {
  const { w, h, img } = l;
  const known = new Uint8Array(w * h);
  let remaining = 0;
  for (let i = 0; i < w * h; i++) {
    known[i] = l.hole[i] ? 0 : 1;
    if (!known[i]) remaining++;
  }
  while (remaining) {
    const ring: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h && known[ny * w + nx]) {
              for (let c = 0; c < 4; c++) acc[c] += img[(ny * w + nx) * 4 + c];
              n++;
            }
          }
        }
        if (n) {
          for (let c = 0; c < 4; c++) img[i * 4 + c] = acc[c] / n;
          ring.push(i);
        }
      }
    }
    if (!ring.length) throw new Error('Nothing to fill from: the selection covers the whole area');
    for (const i of ring) known[i] = 1;
    remaining -= ring.length;
  }
}

class Solver {
  readonly valid: Uint8Array;
  readonly validList: Int32Array;
  readonly targets: Int32Array;
  /** Source centre per pixel (-1 where the pixel is not a target). */
  nnf: Int32Array;
  readonly dist: Float64Array;
  private readonly P: number;

  constructor(
    readonly l: Level,
    private readonly R: number,
    private readonly rand: () => number,
  ) {
    const { w, h } = l;
    const s = holeIntegral(l);
    this.P = (2 * R + 1) ** 2;
    this.valid = new Uint8Array(w * h);
    const validList: number[] = [];
    const targets: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = x >= R && y >= R && x < w - R && y < h - R;
        if (inside && !holesIn(s, w, x - R, y - R, x + R + 1, y + R + 1)) {
          this.valid[y * w + x] = 1;
          validList.push(y * w + x);
        }
        const x0 = Math.max(0, x - R);
        const y0 = Math.max(0, y - R);
        if (holesIn(s, w, x0, y0, Math.min(w, x + R + 1), Math.min(h, y + R + 1))) targets.push(y * w + x);
      }
    }
    this.validList = Int32Array.from(validList);
    this.targets = Int32Array.from(targets);
    this.nnf = new Int32Array(w * h).fill(-1);
    this.dist = new Float64Array(w * h);
  }

  randomSource(): number {
    return this.validList[Math.floor(this.rand() * this.validList.length)];
  }

  randomInit(): void {
    for (const t of this.targets) this.nnf[t] = this.randomSource();
  }

  /** NNF from the coarser level's solution: same relative position, doubled. */
  upsampleFrom(c: Solver): void {
    const { w } = this.l;
    const cw = c.l.w;
    for (const t of this.targets) {
      const x = t % w;
      const y = (t - x) / w;
      const cs = c.nnf[Math.min(c.l.h - 1, y >> 1) * cw + Math.min(cw - 1, x >> 1)];
      let s = -1;
      if (cs >= 0) {
        const sx = 2 * (cs % cw) + (x & 1);
        const sy = 2 * Math.floor(cs / cw) + (y & 1);
        if (sx < w && sy < this.l.h && this.valid[sy * w + sx]) s = sy * w + sx;
      }
      this.nnf[t] = s >= 0 ? s : this.randomSource();
    }
  }

  /** Sum of squared differences over the patch (target pixels outside the image are skipped). */
  patchDist(t: number, s: number, cutoff: number): number {
    const { w, h, img } = this.l;
    const R = this.R;
    const tx = t % w;
    const ty = (t - tx) / w;
    const sx = s % w;
    const sy = (s - sx) / w;
    let d = 0;
    for (let dy = -R; dy <= R; dy++) {
      const y = ty + dy;
      if (y < 0 || y >= h) continue;
      const trow = y * w;
      const srow = (sy + dy) * w;
      for (let dx = -R; dx <= R; dx++) {
        const x = tx + dx;
        if (x < 0 || x >= w) continue;
        const a = (trow + x) * 4;
        const b = (srow + sx + dx) * 4;
        const d0 = img[a] - img[b];
        const d1 = img[a + 1] - img[b + 1];
        const d2 = img[a + 2] - img[b + 2];
        const d3 = img[a + 3] - img[b + 3];
        d += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
      }
      if (d >= cutoff) return d;
    }
    return d;
  }

  patchMatch(passes: number): void {
    const { w, h } = this.l;
    for (const t of this.targets) this.dist[t] = this.patchDist(t, this.nnf[t], Infinity);
    const n = this.targets.length;
    for (let pass = 0; pass < passes; pass++) {
      const fwd = pass % 2 === 0;
      const dir = fwd ? -1 : 1;
      for (let k = 0; k < n; k++) {
        const t = this.targets[fwd ? k : n - 1 - k];
        const tx = t % w;
        const ty = (t - tx) / w;
        const tryCand = (s: number) => {
          if (s < 0 || !this.valid[s] || s === this.nnf[t]) return;
          const d = this.patchDist(t, s, this.dist[t]);
          if (d < this.dist[t]) {
            this.dist[t] = d;
            this.nnf[t] = s;
          }
        };
        // Propagation: a neighbour's match, shifted back by the same step.
        if (tx + dir >= 0 && tx + dir < w) {
          const ns = this.nnf[t + dir];
          if (ns >= 0) {
            const sx = (ns % w) - dir;
            if (sx >= 0 && sx < w) tryCand(ns - dir);
          }
        }
        if (ty + dir >= 0 && ty + dir < h) {
          const ns = this.nnf[t + dir * w];
          if (ns >= 0) tryCand(ns - dir * w);
        }
        // Random search in shrinking windows around the current best.
        for (let r = Math.max(w, h); r >= 1; r = Math.floor(r / 2)) {
          const s = this.nnf[t];
          const sx = (s % w) + Math.round((this.rand() * 2 - 1) * r);
          const sy = Math.floor(s / w) + Math.round((this.rand() * 2 - 1) * r);
          if (sx >= 0 && sy >= 0 && sx < w && sy < h) tryCand(sy * w + sx);
        }
      }
    }
  }

  /** Each hole pixel becomes the similarity-weighted average of what the overlapping patches propose. */
  vote(): void {
    const { w, h, img, hole } = this.l;
    const R = this.R;
    const acc = new Float64Array(w * h * 4);
    const wsum = new Float64Array(w * h);
    let mean = 0;
    for (const t of this.targets) mean += this.dist[t] / this.P;
    mean = mean / Math.max(1, this.targets.length) + 1e-6;
    for (const t of this.targets) {
      const s = this.nnf[t];
      const wt = Math.exp(-this.dist[t] / this.P / (2 * mean));
      const tx = t % w;
      const ty = (t - tx) / w;
      const sx = s % w;
      const sy = (s - sx) / w;
      for (let dy = -R; dy <= R; dy++) {
        const y = ty + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const x = tx + dx;
          if (x < 0 || x >= w) continue;
          const q = y * w + x;
          if (!hole[q]) continue;
          const b = ((sy + dy) * w + sx + dx) * 4;
          for (let c = 0; c < 4; c++) acc[q * 4 + c] += wt * img[b + c];
          wsum[q] += wt;
        }
      }
    }
    for (let q = 0; q < w * h; q++) {
      if (!hole[q] || !wsum[q]) continue;
      for (let c = 0; c < 4; c++) img[q * 4 + c] = acc[q * 4 + c] / wsum[q];
    }
  }

  /** Votes need distances: computes them for the current NNF and image. */
  refreshDistances(): void {
    for (const t of this.targets) this.dist[t] = this.patchDist(t, this.nnf[t], Infinity);
  }
}

/** Returns a copy of `rgba` with the pixels where `hole` is 1 filled from the rest of the image. */
export function inpaint(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, hole: Uint8Array, opts: InpaintOptions = {}): Uint8ClampedArray {
  const R = opts.patchRadius ?? 3;
  const rand = mulberry32(opts.seed ?? 1);
  const out = new Uint8ClampedArray(rgba);
  if (!hole.some(Boolean)) return out;
  const base: Level = { w, h, img: Float32Array.from(rgba), hole };
  const levels = [base];
  for (;;) {
    const l = levels[levels.length - 1];
    // Stop once the hole is about patch-sized or the image too small for useful patches.
    if (Math.min(l.w, l.h) < 4 * (2 * R + 1) || holeExtent(l) <= 2 * R + 1) break;
    const next = downsample(l);
    if (new Solver(next, R, rand).validList.length === 0) break;
    levels.push(next);
  }

  let prev: Solver | undefined;
  for (let i = levels.length - 1; i >= 0; i--) {
    const s = new Solver(levels[i], R, rand);
    if (!s.validList.length) throw new Error('Not enough surrounding pixels to fill the selection from');
    if (prev) {
      s.upsampleFrom(prev);
      s.refreshDistances();
      s.vote();
    } else {
      diffuseFill(levels[i]);
      s.randomInit();
    }
    const em = i === 0 ? 2 : 4;
    for (let k = 0; k < em; k++) {
      s.patchMatch(2);
      s.vote();
    }
    prev = s;
  }
  for (let q = 0; q < w * h; q++) {
    if (!hole[q]) continue;
    for (let c = 0; c < 4; c++) out[q * 4 + c] = Math.round(base.img[q * 4 + c]);
  }
  return out;
}

/** Area worth giving the solver: the hole bounds plus a margin (at least `minMargin`), clamped to w×h. */
export function contextRect(
  hole: { x: number; y: number; w: number; h: number },
  w: number,
  h: number,
  minMargin = 24,
): { x: number; y: number; w: number; h: number } {
  const m = Math.max(minMargin, Math.round(Math.max(hole.w, hole.h) * 0.75));
  const x0 = Math.max(0, hole.x - m);
  const y0 = Math.max(0, hole.y - m);
  const x1 = Math.min(w, hole.x + hole.w + m);
  const y1 = Math.min(h, hole.y + hole.h + m);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
