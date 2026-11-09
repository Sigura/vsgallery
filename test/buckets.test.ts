import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitAspect, kohyaBuckets, nearestBucket, snapAngle, snapDown } from '../src/shared/buckets';
import { encodeBmp24 } from '../src/shared/bmp';
import { parseImageSize } from '../src/host/imageHeader';

const has = (list: { w: number; h: number }[], w: number, h: number) => list.some((b) => b.w === w && b.h === h);

test('kohya SDXL buckets contain the well-known resolutions and respect the area and step', () => {
  const b = kohyaBuckets(1024, 256, 2048, 64);
  for (const [w, h] of [
    [1024, 1024],
    [1152, 896],
    [896, 1152],
    [1216, 832],
    [832, 1216],
    [1344, 768],
    [768, 1344],
    [1536, 640],
    [640, 1536],
  ]) {
    assert.ok(has(b, w, h), `missing ${w}x${h}`);
  }
  for (const { w, h } of b) {
    assert.equal(w % 64, 0);
    assert.equal(h % 64, 0);
    assert.ok(w * h <= 1024 * 1024);
  }
  for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].w / b[i - 1].h <= b[i].w / b[i].h);
});

test('max_bucket_reso caps the long side', () => {
  const b = kohyaBuckets(512, 256, 1024, 64);
  assert.ok(has(b, 512, 512));
  assert.ok(b.every(({ w, h }) => w <= 1024 && h <= 1024 && w >= 256 && h >= 256));
});

test('nearestBucket picks the smallest aspect-ratio error', () => {
  const b = kohyaBuckets(1024);
  assert.deepEqual(nearestBucket(3000, 2000, b), { w: 1216, h: 832 });
  assert.deepEqual(nearestBucket(1000, 1000, b), { w: 1024, h: 1024 });
  assert.deepEqual(nearestBucket(1080, 1920, b), { w: 768, h: 1344 });
});

test('snapDown', () => {
  assert.equal(snapDown(1023, 8), 1016);
  assert.equal(snapDown(1024, 64), 1024);
  assert.equal(snapDown(5, 8), 8);
  assert.equal(snapDown(37.6, 1), 37);
});

test('fitAspect', () => {
  assert.deepEqual(fitAspect(1000, 500, 1), { w: 500, h: 500 });
  assert.deepEqual(fitAspect(400, 1000, 2), { w: 400, h: 200 });
});

test('snapAngle rounds to 15° steps and keeps length', () => {
  const r = snapAngle(10, 1);
  assert.ok(Math.abs(r.dy) < 1e-9);
  assert.ok(Math.abs(r.dx - Math.hypot(10, 1)) < 1e-9);
  const d = snapAngle(10, 9);
  assert.ok(Math.abs(Math.atan2(d.dy, d.dx) - Math.PI / 4) < 1e-9);
});

test('encodeBmp24 writes a valid header, padded bottom-up BGR rows, and flattens alpha', () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255, /**/ 0, 255, 0, 255, /**/ 0, 0, 255, 255,
    0, 0, 0, 0, /**/ 10, 20, 30, 255, /**/ 0, 0, 0, 128,
  ]);
  const bmp = encodeBmp24(3, 2, rgba);
  assert.deepEqual(parseImageSize(bmp, true), { w: 3, h: 2 });
  const rowSize = 12;
  assert.equal(bmp.length, 54 + rowSize * 2);
  // Bottom row in the file is the last image row: transparent -> white background.
  assert.deepEqual([...bmp.subarray(54, 57)], [255, 255, 255]);
  assert.deepEqual([...bmp.subarray(57, 60)], [30, 20, 10]);
  assert.deepEqual([...bmp.subarray(60, 63)], [127, 127, 127]);
  // Top image row is stored second.
  assert.deepEqual([...bmp.subarray(54 + rowSize, 54 + rowSize + 9)], [0, 0, 255, 0, 255, 0, 255, 0, 0]);
});
