import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineCaption, parseSelectedTags, postprocess, resultTags, squarePlacement, toModelInput } from '../src/shared/tagger';

const CSV = [
  'tag_id,name,category,count',
  '9999999,general,9,807489',
  '9999998,sensitive,9,3360',
  '470575,1girl,0,4210890',
  '212816,solo,0,3426446',
  '1300281,long_hair,0,2978051',
  '1709,^_^,0,30000',
  '1,"comma,tag",0,5',
  '2,hatsune_miku,4,100000',
  '3,kagamine_rin,4,50000',
].join('\r\n');

const opts = { generalThreshold: 0.35, characterThreshold: 0.85, excludeTags: [], replaceUnderscores: true };

test('parseSelectedTags reads names and categories in row order, with quoted fields', () => {
  const l = parseSelectedTags(CSV + '\n');
  assert.equal(l.names.length, 9);
  assert.deepEqual(l.names.slice(0, 3), ['general', 'sensitive', '1girl']);
  assert.equal(l.names[6], 'comma,tag');
  assert.deepEqual(l.categories, [9, 9, 0, 0, 0, 0, 0, 4, 4]);
});

test('parseSelectedTags rejects files without the expected columns', () => {
  assert.throws(() => parseSelectedTags('a,b\n1,2'), /name/);
});

test('postprocess applies per-category thresholds, sorts by confidence and picks the rating', () => {
  const labels = parseSelectedTags(CSV);
  const probs = [0.2, 0.7, 0.99, 0.5, 0.36, 0.9, 0.1, 0.86, 0.84];
  const r = postprocess(probs, labels, opts);
  assert.deepEqual(r.rating, { tag: 'sensitive', p: 0.7 });
  assert.deepEqual(r.character.map((t) => t.tag), ['hatsune miku']);
  assert.deepEqual(r.general.map((t) => t.tag), ['1girl', '^_^', 'solo', 'long hair']);
  assert.deepEqual(resultTags(r), ['hatsune miku', '1girl', '^_^', 'solo', 'long hair']);
});

test('postprocess keeps only scores strictly above the thresholds, like the reference tagger', () => {
  const labels = parseSelectedTags(CSV);
  const r = postprocess([0, 0, 0.35, 0.3501, 0, 0, 0, 0.85, 0.8501], labels, opts);
  assert.deepEqual(resultTags(r), ['kagamine rin', 'solo']);
});

test('postprocess keeps underscores when asked and matches exclusions with either spelling', () => {
  const labels = parseSelectedTags(CSV);
  const probs = [0, 0, 0.99, 0.5, 0.36, 0.9, 0, 0.9, 0];
  const keep = postprocess(probs, labels, { ...opts, replaceUnderscores: false, excludeTags: ['Long Hair', 'hatsune_miku'] });
  assert.deepEqual(resultTags(keep), ['1girl', '^_^', 'solo']);
  const spaced = postprocess(probs, labels, { ...opts, excludeTags: ['long_hair', '^_^'] });
  assert.deepEqual(resultTags(spaced), ['hatsune miku', '1girl', 'solo']);
});

test('postprocess rejects a score count that does not match the labels', () => {
  assert.throws(() => postprocess([0.5], parseSelectedTags(CSV), opts), /9 tags/);
});

test('combineCaption: skip, overwrite and append with a trigger word', () => {
  const gen = ['1girl', 'solo', 'mytoken'];
  assert.equal(combineCaption('old, tags', gen, 'skip', ''), undefined);
  assert.equal(combineCaption('  , ', gen, 'skip', ''), '1girl, solo, mytoken');
  assert.equal(combineCaption(null, gen, 'skip', 'mytoken'), 'mytoken, 1girl, solo');
  assert.equal(combineCaption('old, Solo', gen, 'overwrite', ''), '1girl, solo, mytoken');
  assert.equal(combineCaption('old, Solo', gen, 'append', ''), 'old, Solo, 1girl, mytoken');
  assert.equal(combineCaption('old, MyToken', gen, 'append', 'mytoken'), 'mytoken, old, 1girl, solo');
});

test('toModelInput composites on white, converts to BGR and keeps 0-255', () => {
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0, 200, 100, 0, 128, 1, 2, 3, 255]);
  const x = toModelInput(rgba, 2);
  assert.equal(x.length, 12);
  assert.deepEqual([...x.slice(0, 3)], [30, 20, 10]);
  assert.deepEqual([...x.slice(3, 6)], [255, 255, 255]);
  const a = 128 / 255;
  const expect = [0 * a + 255 * (1 - a), 100 * a + 255 * (1 - a), 200 * a + 255 * (1 - a)];
  x.slice(6, 9).forEach((v, i) => assert.ok(Math.abs(v - expect[i]) < 1e-3));
  assert.throws(() => toModelInput(rgba, 3), /3×3/);
});

test('squarePlacement centres the image with integer padding', () => {
  assert.deepEqual(squarePlacement(100, 50, 448), { x: 0, y: 112, w: 448, h: 224 });
  assert.deepEqual(squarePlacement(51, 100, 100), { x: 24, y: 0, w: 51, h: 100 });
  assert.deepEqual(squarePlacement(448, 448, 448), { x: 0, y: 0, w: 448, h: 448 });
});
