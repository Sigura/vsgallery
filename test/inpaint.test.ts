import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextRect, inpaint } from '../src/shared/inpaint';
import { DabSpacer } from '../src/shared/dabs';

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(px(x, y), (y * w + x) * 4);
  return d;
}

function holeRect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

test('inpaint fills a hole in a flat image with that colour and leaves other pixels alone', () => {
  const w = 40;
  const h = 30;
  const img = image(w, h, (x, y) => (x >= 15 && x < 25 && y >= 10 && y < 20 ? [255, 0, 0, 255] : [30, 120, 200, 255]));
  const hole = holeRect(w, h, 15, 10, 25, 20);
  const out = inpaint(img, w, h, hole);
  for (let i = 0; i < w * h; i++) {
    const px = [...out.slice(i * 4, i * 4 + 4)];
    if (hole[i]) assert.deepEqual(px, [30, 120, 200, 255], `hole pixel ${i}`);
    else assert.deepEqual(px, [...img.slice(i * 4, i * 4 + 4)]);
  }
});

test('inpaint continues vertical stripes through the hole', () => {
  const w = 64;
  const h = 48;
  const stripe = (x: number): [number, number, number, number] => (Math.floor(x / 4) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
  const img = image(w, h, (x) => stripe(x));
  const hole = holeRect(w, h, 24, 16, 40, 32);
  for (let i = 0; i < w * h; i++) if (hole[i]) img.set([128, 0, 128, 255], i * 4);
  const out = inpaint(img, w, h, hole, { seed: 7 });
  let wrong = 0;
  for (let y = 16; y < 32; y++) {
    for (let x = 24; x < 40; x++) {
      const v = out[(y * w + x) * 4];
      if (Math.abs(v - stripe(x)[0]) > 64) wrong++;
    }
  }
  assert.ok(wrong <= 16 * 16 * 0.1, `${wrong} of 256 hole pixels off the stripe pattern`);
});

test('inpaint without a hole returns an equal copy; with no source patches it throws', () => {
  const img = image(8, 8, () => [1, 2, 3, 4]);
  const same = inpaint(img, 8, 8, new Uint8Array(64));
  assert.notEqual(same, img);
  assert.deepEqual([...same], [...img]);
  assert.throws(() => inpaint(img, 8, 8, new Uint8Array(64).fill(1)), /fill/);
});

test('contextRect adds a margin and clamps', () => {
  assert.deepEqual(contextRect({ x: 50, y: 50, w: 10, h: 40 }, 200, 100), { x: 20, y: 20, w: 70, h: 80 });
  assert.deepEqual(contextRect({ x: 0, y: 0, w: 4, h: 4 }, 10, 10, 24), { x: 0, y: 0, w: 10, h: 10 });
});

test('DabSpacer spaces dabs evenly across segments', () => {
  const s = new DabSpacer(() => 10);
  assert.deepEqual(s.begin({ x: 0, y: 0, pressure: 1 }), [{ x: 0, y: 0, pressure: 1 }]);
  assert.deepEqual(s.to({ x: 15, y: 0, pressure: 1 }).map((p) => p.x), [10]);
  assert.deepEqual(s.to({ x: 32, y: 0, pressure: 1 }).map((p) => p.x), [20, 30]);
  assert.deepEqual(s.to({ x: 32, y: 0, pressure: 1 }), []);
  assert.deepEqual(s.lastPoint, { x: 32, y: 0, pressure: 1 });
});
