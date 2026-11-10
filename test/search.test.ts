import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch } from '../src/shared/search';

test('words are separate terms', () => {
  assert.deepEqual(parseSearch('  Dress  Behind '), { include: ['dress', 'behind'], text: 'dress behind', exclude: [] });
});

test('dash terms are exclusions', () => {
  assert.deepEqual(parseSearch('dress -red -Hat'), { include: ['dress'], text: 'dress', exclude: ['red', 'hat'] });
  assert.deepEqual(parseSearch('-red'), { include: [], text: '', exclude: ['red'] });
});

test('quotes keep phrases together', () => {
  assert.deepEqual(parseSearch('girl -"blue  eyes" "from behind"'), {
    include: ['girl', 'from behind'],
    text: 'girl from behind',
    exclude: ['blue eyes'],
  });
});

test('dash inside a word or alone is literal', () => {
  assert.deepEqual(parseSearch('t-shirt').include, ['t-shirt']);
  assert.deepEqual(parseSearch('a - b').include, ['a', '-', 'b']);
  assert.deepEqual(parseSearch('-""'), { include: [], text: '', exclude: [] });
});
