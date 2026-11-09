import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approxTokens, qualityFlags, wordCount, type QualityOptions } from '../src/shared/quality';

const o: QualityOptions = { minResolution: 512, blurThreshold: 100, maxAspect: 2.5, minWords: 3, maxTokens: 20 };

test('size flags need known dimensions', () => {
  assert.deepEqual(qualityFlags({ w: 1024, h: 1024, caption: 'a cat on a mat' }, o), []);
  assert.deepEqual(qualityFlags({ w: 0, h: 0, caption: 'a cat on a mat' }, o), []);
  assert.deepEqual(qualityFlags({ w: 1000, h: 400, caption: 'a cat on a mat' }, o), ['small', 'not64']);
  assert.deepEqual(qualityFlags({ w: 1027, h: 1024, caption: 'a cat on a mat' }, o), ['not8', 'not64']);
  assert.deepEqual(qualityFlags({ w: 2048, h: 768, caption: 'a cat on a mat' }, o), ['aspect']);
  assert.deepEqual(qualityFlags({ w: 1280, h: 512, caption: 'a cat on a mat' }, o), []);
});

test('blur flag only once analysed', () => {
  assert.deepEqual(qualityFlags({ w: 1024, h: 1024, caption: 'a cat on a mat', sharpness: 10 }, o), ['blur']);
  assert.deepEqual(qualityFlags({ w: 1024, h: 1024, caption: 'a cat on a mat', sharpness: 100 }, o), []);
});

test('caption flags', () => {
  const f = (caption: string | null | undefined) => qualityFlags({ w: 1024, h: 1024, caption }, o);
  assert.deepEqual(f(null), ['noCaption']);
  assert.deepEqual(f(' , '), ['emptyCaption']);
  assert.deepEqual(f(undefined), []);
  assert.deepEqual(f('1girl, solo'), ['shortCaption']);
  assert.deepEqual(f(Array.from({ length: 11 }, (_, i) => `t${i}`).join(', ')), ['longCaption']);
});

test('token and word estimates', () => {
  assert.equal(approxTokens('1girl, solo, looking_at_viewer.'), 6);
  assert.equal(approxTokens('Ünïcode wörds!'), 3);
  assert.equal(wordCount('a photo, of  a cat'), 5);
  assert.equal(approxTokens(''), 0);
});
