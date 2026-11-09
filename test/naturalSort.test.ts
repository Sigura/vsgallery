import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryComparator, naturalCompare } from '../src/shared/naturalSort';
import type { ImageEntry } from '../src/shared/protocol';

test('numbers compare by value', () => {
  const names = ['img10', 'img2', 'img1', 'img100', 'img20'];
  assert.deepEqual([...names].sort(naturalCompare), ['img1', 'img2', 'img10', 'img20', 'img100']);
});

test('case-insensitive with deterministic tie-break', () => {
  assert.ok(naturalCompare('a', 'B') < 0);
  assert.notEqual(naturalCompare('A', 'a'), 0);
  assert.equal(naturalCompare('x', 'x'), 0);
});

test('leading zeros and mixed segments', () => {
  const names = ['10_char', '2_char', '1_char', 'a9b10', 'a9b2'];
  assert.deepEqual([...names].sort(naturalCompare), ['1_char', '2_char', '10_char', 'a9b2', 'a9b10']);
  assert.ok(naturalCompare('img002', 'img10') < 0);
});

const e = (id: string, w: number, h: number, size = 1, mtime = 1): ImageEntry => ({
  id,
  dir: '',
  name: id,
  size,
  mtime,
  w,
  h,
  thumb: '',
  hasThumb: false,
});

test('resolution sort keeps unknown sizes last in both directions', () => {
  const list = [e('a', 0, 0), e('b', 512, 512), e('c', 1024, 1024), e('d', 768, 512)];
  const ids = (k: 'asc' | 'desc') => [...list].sort(entryComparator('resolution', k)).map((x) => x.id);
  assert.deepEqual(ids('asc'), ['b', 'd', 'c', 'a']);
  assert.deepEqual(ids('desc'), ['c', 'd', 'b', 'a']);
});

test('aspect sort with natural name tie-break', () => {
  const list = [e('img10', 100, 100), e('img2', 100, 100), e('wide', 200, 100)];
  assert.deepEqual(
    [...list].sort(entryComparator('aspect', 'asc')).map((x) => x.id),
    ['img2', 'img10', 'wide'],
  );
});

test('name sort descending reverses natural order', () => {
  const list = [e('img2', 1, 1), e('img10', 1, 1), e('img1', 1, 1)];
  assert.deepEqual(
    [...list].sort(entryComparator('name', 'desc')).map((x) => x.id),
    ['img10', 'img2', 'img1'],
  );
});
