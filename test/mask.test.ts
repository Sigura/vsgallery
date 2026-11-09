import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineMasks, floodFill, invertMask, maskBounds, maskOutline, polygonMask, rectMask } from '../src/shared/mask';
import { fitScale, flipRect, intersectRect, resizeByCorner, rotateRect, unionRect } from '../src/shared/layerMath';

const rows = (m: Uint8Array, w: number) => Array.from({ length: m.length / w }, (_, y) => [...m.slice(y * w, y * w + w)].join(''));

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(px(x, y), (y * w + x) * 4);
  return d;
}

test('floodFill selects the contiguous region within tolerance only', () => {
  // Left half grey 100 (with one 105 pixel), a black wall in column 2, right half grey 100 again.
  const img = image(5, 3, (x, y) => (x === 2 ? [0, 0, 0, 255] : x === 1 && y === 1 ? [105, 105, 105, 255] : [100, 100, 100, 255]));
  assert.deepEqual(rows(floodFill(img, 5, 3, 0, 0, 8), 5), ['11000', '11000', '11000']);
  assert.deepEqual(rows(floodFill(img, 5, 3, 0, 0, 4), 5), ['11000', '10000', '11000']);
  assert.deepEqual(rows(floodFill(img, 5, 3, 4, 2, 8), 5), ['00011', '00011', '00011']);
  assert.equal(floodFill(img, 5, 3, 9, 9, 8).some(Boolean), false);
});

test('floodFill compares alpha too and handles a U shape', () => {
  const img = image(4, 3, (x, y) => (y < 2 && (x === 1 || x === 2) ? [0, 0, 0, 0] : [0, 0, 0, 255]));
  assert.deepEqual(rows(floodFill(img, 4, 3, 0, 0, 8), 4), ['1001', '1001', '1111']);
});

test('rectMask clamps and rounds', () => {
  assert.deepEqual(rows(rectMask(4, 3, { x: -1, y: 1, w: 3, h: 9 }), 4), ['0000', '1100', '1100']);
});

test('polygonMask fills pixels whose centre is inside', () => {
  const tri = polygonMask(4, 4, [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 0, y: 4 },
  ]);
  assert.deepEqual(rows(tri, 4), ['1110', '1100', '1000', '0000']);
  assert.deepEqual(rows(polygonMask(3, 2, [{ x: 0, y: 0 }, { x: 3, y: 0 }]), 3), ['000', '000']);
});

test('combineMasks, invertMask and maskBounds', () => {
  const a = rectMask(4, 1, { x: 0, y: 0, w: 2, h: 1 });
  const b = rectMask(4, 1, { x: 1, y: 0, w: 2, h: 1 });
  assert.deepEqual([...combineMasks(a, b, 'add')], [1, 1, 1, 0]);
  assert.deepEqual([...combineMasks(a, b, 'subtract')], [1, 0, 0, 0]);
  assert.equal(combineMasks(a, b, 'replace'), b);
  assert.deepEqual([...combineMasks(undefined, b, 'subtract')], [0, 0, 0, 0]);
  assert.deepEqual([...invertMask(a)], [0, 0, 1, 1]);
  assert.deepEqual(maskBounds(rectMask(5, 4, { x: 1, y: 2, w: 3, h: 1 }), 5, 4), { x: 1, y: 2, w: 3, h: 1 });
  assert.equal(maskBounds(new Uint8Array(4), 2, 2), undefined);
});

test('maskOutline traces a rectangle with four merged segments', () => {
  const segs = maskOutline(rectMask(4, 4, { x: 1, y: 1, w: 2, h: 2 }), 4, 4);
  assert.equal(segs.length, 16);
  const set = new Set(Array.from({ length: 4 }, (_, i) => segs.slice(i * 4, i * 4 + 4).join(',')));
  assert.deepEqual(set, new Set(['1,1,3,1', '1,3,3,3', '1,1,1,3', '3,1,3,3']));
});

test('resizeByCorner keeps the opposite corner and optionally the aspect ratio', () => {
  const r = { x: 10, y: 10, w: 100, h: 50 };
  assert.deepEqual(resizeByCorner(r, 'se', 150, 80, false), { x: 10, y: 10, w: 140, h: 70 });
  assert.deepEqual(resizeByCorner(r, 'nw', 60, 0, false), { x: 60, y: 0, w: 50, h: 60 });
  assert.deepEqual(resizeByCorner(r, 'se', 210, 70, true), { x: 10, y: 10, w: 200, h: 100 });
  assert.deepEqual(resizeByCorner(r, 'ne', 0, 100, false), { x: 10, y: 59, w: 1, h: 1 });
});

test('flipRect and rotateRect map layer placement with the document', () => {
  const r = { x: 10, y: 20, w: 30, h: 40 };
  assert.deepEqual(flipRect(r, true, 100, 200), { x: 60, y: 20, w: 30, h: 40 });
  assert.deepEqual(flipRect(r, false, 100, 200), { x: 10, y: 140, w: 30, h: 40 });
  assert.deepEqual(rotateRect(r, true, 100, 200), { x: 140, y: 10, w: 40, h: 30 });
  assert.deepEqual(rotateRect(r, false, 100, 200), { x: 20, y: 60, w: 40, h: 30 });
  const back = rotateRect(rotateRect(r, true, 100, 200), false, 200, 100);
  assert.deepEqual(back, r);
});

test('fitScale, intersectRect and unionRect', () => {
  assert.equal(fitScale(200, 100, 100, 100), 0.5);
  assert.equal(fitScale(50, 50, 100, 100), 1);
  assert.deepEqual(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 }), { x: 5, y: 0, w: 5, h: 5 });
  assert.equal(intersectRect({ x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 }), undefined);
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 1, h: 1 }, { x: 3, y: -2, w: 1, h: 1 }), { x: 0, y: -2, w: 4, h: 3 });
});
