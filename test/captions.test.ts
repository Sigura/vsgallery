import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCaption, isCaptionEmpty, joinTags, mergeTags, parseTags, suggestTags, tagFrequency } from '../src/shared/captions';

test('parseTags trims, drops empties and collapses inner whitespace', () => {
  assert.deepEqual(parseTags(' 1girl,  solo ,,blue   eyes,\n smile ,'), ['1girl', 'solo', 'blue eyes', 'smile']);
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags('a photo of a door'), ['a photo of a door']);
});

test('isCaptionEmpty', () => {
  assert.equal(isCaptionEmpty(''), true);
  assert.equal(isCaptionEmpty(' \n\t '), true);
  assert.equal(isCaptionEmpty(' , ,, '), true);
  assert.equal(isCaptionEmpty('door'), false);
});

test('decodeCaption strips a UTF-8 BOM and keeps unicode', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('дверь, door')]);
  assert.equal(decodeCaption(bytes), 'дверь, door');
  assert.equal(decodeCaption(new TextEncoder().encode('x')), 'x');
});

test('mergeTags keeps external edits, my removals and my additions', () => {
  const base = ['a', 'b', 'c'];
  const mine = ['a', 'c', 'mine'];
  const theirs = ['a', 'b', 'c', 'theirs'];
  assert.deepEqual(mergeTags(base, mine, theirs), ['a', 'c', 'theirs', 'mine']);
});

test('mergeTags de-duplicates case-insensitively and respects their reorder', () => {
  assert.deepEqual(mergeTags(['x', 'y'], ['x', 'y', 'Z'], ['y', 'x', 'z']), ['y', 'x', 'z']);
});

test('tagFrequency counts once per caption', () => {
  const f = tagFrequency(['a, b, a', 'A, c', '']);
  assert.equal(f.get('a'), 2);
  assert.equal(f.get('b'), 1);
  assert.equal(f.get('c'), 1);
});

test('suggestTags ranks prefix matches before substring matches, then by frequency', () => {
  const freq = new Map([
    ['blue eyes', 5],
    ['blonde hair', 9],
    ['sky blue', 20],
    ['blush', 1],
  ]);
  assert.deepEqual(suggestTags(freq, 'bl', new Set()), ['blonde hair', 'blue eyes', 'blush', 'sky blue']);
  assert.deepEqual(suggestTags(freq, 'blu', new Set(['blush'])), ['blue eyes', 'sky blue']);
  assert.deepEqual(suggestTags(freq, ' ', new Set()), []);
});

test('joinTags', () => {
  assert.equal(joinTags(['a', 'b c']), 'a, b c');
});
