import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetStats } from '../src/shared/datasetStats';
import { kohyaBuckets } from '../src/shared/buckets';

const buckets = kohyaBuckets(1024, 256, 2048, 64);

test('folders with kohya repeats give samples per epoch', () => {
  const s = datasetStats(
    [
      { dir: 'img/10_char', w: 1024, h: 1024, caption: 'a' },
      { dir: 'img/10_char', w: 1024, h: 1024, caption: 'a' },
      { dir: 'img/2_style', w: 1024, h: 1024, caption: 'a' },
      { dir: '', w: 1024, h: 1024, caption: 'a' },
    ],
    buckets,
  );
  assert.equal(s.images, 4);
  assert.equal(s.samplesPerEpoch, 23);
  assert.deepEqual(
    s.folders.map((f) => [f.dir, f.label, f.repeats, f.hasRepeats, f.images, f.samples]),
    [
      ['', '(root)', 1, false, 1, 1],
      ['img/2_style', 'style', 2, true, 1, 2],
      ['img/10_char', 'char', 10, true, 2, 20],
    ],
  );
});

test('resolution, orientation and bucket counts', () => {
  const s = datasetStats(
    [
      { dir: '', w: 400, h: 600 },
      { dir: '', w: 1024, h: 1024 },
      { dir: '', w: 2000, h: 2000 },
      { dir: '', w: 1216, h: 832 },
      { dir: '', w: 0, h: 0 },
    ],
    buckets,
  );
  assert.deepEqual(
    s.resolution.map((r) => [r.label, r.n]),
    [
      ['< 512', 1],
      ['512–767', 0],
      ['768–1023', 1],
      ['1024–1535', 1],
      ['≥ 1536', 1],
    ],
  );
  assert.deepEqual(
    s.orientation.map((r) => [r.label, r.n]),
    [
      ['Landscape', 1],
      ['Portrait', 1],
      ['Square', 2],
    ],
  );
  assert.equal(s.unknownSize, 1);
  assert.deepEqual(s.buckets[0], { label: '1024×1024', n: 2 });
  assert.equal(s.buckets.reduce((n, b) => n + b.n, 0), 4);
  assert.ok(s.buckets.some((b) => b.label === '1216×832'));
});

test('caption coverage and tag counts', () => {
  const s = datasetStats(
    [
      { dir: '', w: 1, h: 1, caption: 'cat, dog' },
      { dir: '', w: 1, h: 1, caption: 'Cat, bird, cat' },
      { dir: '', w: 1, h: 1, caption: '' },
      { dir: '', w: 1, h: 1, caption: null },
      { dir: '', w: 1, h: 1 },
    ],
    [],
  );
  assert.deepEqual(s.captions, { withText: 2, missing: 1, empty: 1, notLoaded: 1 });
  assert.equal(s.tags.unique, 3);
  assert.equal(s.tags.total, 5);
  assert.equal(s.tags.perCaption, 2.5);
  assert.deepEqual(s.tags.top[0], { label: 'cat', n: 2 });
  assert.equal(s.buckets.length, 0);
});
