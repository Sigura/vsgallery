import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dHash, groupByHash, hamming, pHash, resizeGray, sharpness, toGray, type Gray } from '../src/shared/imageHash';

function make(w: number, h: number, f: (x: number, y: number) => number): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { w, h, data };
}

const scene = (x: number, y: number) => 128 + 60 * Math.sin(x / 7) * Math.cos(y / 11) + (x > 40 && y < 30 ? 50 : 0);

test('toGray uses Rec.601 luma', () => {
  const g = toGray(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 10, 10, 255]), 2, 2);
  assert.ok(Math.abs(g.data[0] - 76.245) < 1e-3);
  assert.ok(Math.abs(g.data[1] - 149.685) < 1e-3);
  assert.ok(Math.abs(g.data[2] - 29.07) < 1e-3);
  assert.ok(Math.abs(g.data[3] - 10) < 1e-3);
});

test('resizeGray averages areas, including fractional ones', () => {
  const g = make(4, 2, (x) => (x < 2 ? 0 : 100));
  assert.deepEqual([...resizeGray(g, 2, 1).data], [0, 100]);
  const r = resizeGray(make(3, 1, (x) => x * 30), 2, 1);
  assert.ok(Math.abs(r.data[0] - 10) < 1e-4);
  assert.ok(Math.abs(r.data[1] - 50) < 1e-4);
});

test('hamming counts differing bits of 64-bit hex hashes', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hamming('8000000000000001', '0000000000000000'), 2);
  assert.equal(hamming('00000000f0000000', '0000000000000000'), 4);
});

test('hashes are 64-bit, stable under rescale and brightness, different for other content', () => {
  const a = make(200, 150, scene);
  const scaled = resizeGray(a, 120, 90);
  const brighter = make(200, 150, (x, y) => scene(x, y) * 0.8 + 20);
  const other = make(200, 150, (x, y) => 128 + 80 * Math.sin((x + y) / 5) * (y > 75 ? -1 : 1));
  for (const hash of [dHash, pHash]) {
    const h = hash(a);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.ok(hamming(h, hash(scaled)) <= 6, `${hash.name} rescaled`);
    assert.ok(hamming(h, hash(brighter)) <= 4, `${hash.name} brightness`);
    assert.ok(hamming(h, hash(other)) > 16, `${hash.name} other image`);
  }
});

test('pHash of a flipped image differs', () => {
  const a = make(128, 128, scene);
  const flipped = make(128, 128, (x, y) => scene(127 - x, y));
  assert.ok(hamming(pHash(a), pHash(flipped)) > 10);
});

test('groupByHash links pairs within the threshold transitively', () => {
  const groups = groupByHash(
    [
      { id: 'a', hash: '0000000000000000' },
      { id: 'b', hash: '0000000000000003' },
      { id: 'c', hash: '000000000000000f' },
      { id: 'd', hash: 'ffffffffffffffff' },
      { id: 'e', hash: 'fffffffffffffffe' },
      { id: 'f', hash: '00000000ffff0000' },
    ],
    2,
  );
  assert.deepEqual(groups, [
    ['a', 'b', 'c'],
    ['d', 'e'],
  ]);
  assert.deepEqual(groupByHash([{ id: 'a', hash: '0000000000000000' }, { id: 'b', hash: '0000000000000001' }], 0), []);
});

test('sharpness: flat is 0, sharp edges score higher than blurred ones', () => {
  assert.equal(sharpness(make(10, 10, () => 77)), 0);
  const sharp = make(64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 255 : 0);
  const blurred = make(64, 64, (x, y) => 128 + 40 * Math.sin(x / 6) * Math.sin(y / 6));
  assert.ok(sharpness(sharp) > 100 * sharpness(blurred));
  assert.equal(sharpness(make(2, 2, () => 1)), 0);
});

test('sharpness: independent of contrast', () => {
  const edges = (amp: number) => make(64, 64, (x, y) => 128 + amp * ((((x >> 3) + (y >> 3)) % 2) * 2 - 1));
  const hi = sharpness(edges(100));
  assert.ok(hi > 0);
  assert.ok(Math.abs(sharpness(edges(10)) - hi) < 1e-3 * hi);
});
