import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planResize, type ResizeOptions } from '../src/shared/resizePlan';

const base: ResizeOptions = { mode: 'bucket', bucketBase: 1024, size: 1024, snap: 8, upscale: false };

test('bucket mode crops to the nearest bucket aspect and scales to it', () => {
  const p = planResize(3000, 2000, base);
  assert.equal(p.action, 'resize');
  if (p.action !== 'resize') return;
  assert.deepEqual(p.out, { w: 1216, h: 832 });
  assert.equal(p.crop.h, 2000);
  assert.equal(p.crop.w, Math.round((2000 * 1216) / 832));
  assert.equal(p.crop.x, Math.floor((3000 - p.crop.w) / 2));
  assert.equal(p.crop.y, 0);
  assert.ok(p.cropped && p.scaled);
});

test('bucket mode skips images already at their bucket and, without upscale, smaller ones', () => {
  assert.deepEqual(planResize(1216, 832, base), { action: 'skip', reason: 'unchanged' });
  assert.deepEqual(planResize(600, 600, base), { action: 'skip', reason: 'upscale' });
  const up = planResize(600, 600, { ...base, upscale: true });
  assert.equal(up.action, 'resize');
  if (up.action === 'resize') assert.deepEqual(up.out, { w: 1024, h: 1024 });
});

test('maxSide scales the long side down and crops to the snap multiple', () => {
  const p = planResize(4000, 3001, { ...base, mode: 'maxSide', size: 1024, snap: 64 });
  assert.equal(p.action, 'resize');
  if (p.action !== 'resize') return;
  assert.deepEqual(p.out, { w: 1024, h: 768 });
  assert.equal(p.crop.w, 4000);
  assert.equal(p.crop.h, Math.round(768 / (1024 / 4000)));
});

test('maxSide never enlarges small images but still snaps them', () => {
  const p = planResize(500, 333, { ...base, mode: 'maxSide', size: 1024, snap: 8 });
  assert.equal(p.action, 'resize');
  if (p.action !== 'resize') return;
  assert.deepEqual(p.out, { w: 496, h: 328 });
  assert.equal(p.scaled, false);
  assert.deepEqual(p.crop, { x: 2, y: 2, w: 496, h: 328 });
  assert.deepEqual(planResize(512, 320, { ...base, mode: 'maxSide', snap: 64 }), { action: 'skip', reason: 'unchanged' });
});

test('shortSide scales to the target short side and refuses to upscale unless allowed', () => {
  const p = planResize(2000, 3000, { ...base, mode: 'shortSide', size: 768, snap: 64 });
  assert.equal(p.action, 'resize');
  if (p.action === 'resize') assert.deepEqual(p.out, { w: 768, h: 1152 });
  assert.deepEqual(planResize(500, 700, { ...base, mode: 'shortSide', size: 768 }), { action: 'skip', reason: 'upscale' });
});

test('snap mode only crops, and skips images smaller than one multiple', () => {
  const p = planResize(1030, 1000, { ...base, mode: 'snap', snap: 64 });
  assert.equal(p.action, 'resize');
  if (p.action === 'resize') {
    assert.deepEqual(p.out, { w: 1024, h: 960 });
    assert.deepEqual(p.crop, { x: 3, y: 20, w: 1024, h: 960 });
    assert.equal(p.scaled, false);
  }
  assert.deepEqual(planResize(40, 100, { ...base, mode: 'snap', snap: 64 }), { action: 'skip', reason: 'tooSmall' });
});
