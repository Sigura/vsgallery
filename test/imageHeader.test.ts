import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageSize } from '../src/host/imageHeader';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];

test('png', () => {
  const b = bytes([0x89], 'PNG', [13, 10, 26, 10], be32(13), 'IHDR', be32(1216), be32(832));
  assert.deepEqual(parseImageSize(b, true), { w: 1216, h: 832 });
  assert.equal(parseImageSize(b.subarray(0, 20), false), 'more');
  assert.equal(parseImageSize(b.subarray(0, 20), true), null);
});

test('jpeg skips APP segments and finds SOF2', () => {
  const app1 = [0xff, 0xe1, ...be16(2 + 100), ...new Array(100).fill(0)];
  const sof = [0xff, 0xc2, ...be16(17), 8, ...be16(768), ...be16(1344), ...new Array(10).fill(0)];
  const b = new Uint8Array([0xff, 0xd8, ...app1, ...sof]);
  assert.deepEqual(parseImageSize(b, true), { w: 1344, h: 768 });
  assert.equal(parseImageSize(b.subarray(0, 60), false), 'more');
});

test('jpeg tolerates fill bytes before a marker', () => {
  const sof = [0xff, 0xff, 0xff, 0xc0, ...be16(17), 8, ...be16(512), ...be16(640), ...new Array(10).fill(0)];
  assert.deepEqual(parseImageSize(new Uint8Array([0xff, 0xd8, ...sof]), true), { w: 640, h: 512 });
});

test('jpeg without SOF before SOS is rejected', () => {
  assert.equal(parseImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, ...be16(2)]), true), null);
});

test('webp VP8, VP8L, VP8X', () => {
  const head = (kind: string) => [...bytes('RIFF', le32(100), 'WEBP', kind, le32(80))];
  const vp8 = new Uint8Array([...head('VP8 '), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)]);
  assert.deepEqual(parseImageSize(vp8, true), { w: 640, h: 480 });

  const bits = (1023 & 0x3fff) | ((767 & 0x3fff) << 14);
  const vp8l = new Uint8Array([...head('VP8L'), 0x2f, ...le32(bits), 0, 0, 0, 0, 0]);
  assert.deepEqual(parseImageSize(vp8l, true), { w: 1024, h: 768 });

  const vp8x = new Uint8Array([...head('VP8X'), 0, 0, 0, 0, 0xff, 0x07, 0, 0xff, 0x03, 0]);
  assert.deepEqual(parseImageSize(vp8x, true), { w: 2048, h: 1024 });
});

test('bmp with negative (top-down) height', () => {
  const b = bytes('BM', le32(0), le32(0), le32(54), le32(40), le32(512), le32(-256 >>> 0));
  assert.deepEqual(parseImageSize(b, true), { w: 512, h: 256 });
});

test('unknown data', () => {
  assert.equal(parseImageSize(bytes('GIF89a', new Array(30).fill(0)), true), null);
  assert.equal(parseImageSize(new Uint8Array(2), false), 'more');
});
