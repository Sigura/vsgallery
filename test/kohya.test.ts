import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderTag, parseKohyaFolder } from '../src/shared/kohya';

test('kohya repeat prefix', () => {
  assert.deepEqual(parseKohyaFolder('3_door'), { label: 'door', repeats: 3 });
  assert.deepEqual(parseKohyaFolder('10_my_char'), { label: 'my_char', repeats: 10 });
  assert.deepEqual(parseKohyaFolder('door'), { label: 'door' });
  assert.deepEqual(parseKohyaFolder('3_'), { label: '3_' });
});

test('folder tag uses last segment', () => {
  assert.equal(folderTag('3_door'), 'door (3)');
  assert.equal(folderTag('train/10_char'), 'char (10)');
  assert.equal(folderTag('misc'), 'misc');
  assert.equal(folderTag(''), '');
});
