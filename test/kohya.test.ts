import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRepeatTarget, folderTag, isKohyaFolder, parseKohyaFolder, planRepeats } from '../src/shared/kohya';

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

test('repeat plan balances samples per folder', () => {
  const rows = planRepeats(
    [
      { dir: '16_dress', images: 10 },
      { dir: 'train/2_face', images: 40 },
      { dir: 'misc', images: 5 },
      { dir: '', images: 3 },
    ],
    80,
  );
  assert.deepEqual(
    rows.map((r) => [r.dir, r.newRepeats, r.newDir, r.conflict]),
    [
      ['16_dress', 8, '8_dress', undefined],
      ['train/2_face', 2, 'train/2_face', undefined],
    ],
  );
});

test('repeat plan keeps zero padding and at least one repeat', () => {
  const rows = planRepeats([{ dir: '05_dress', images: 300 }], 100);
  assert.equal(rows[0].newDir, '01_dress');
  assert.equal(rows[0].newRepeats, 1);
});

test('repeat plan reports name conflicts', () => {
  const rows = planRepeats(
    [
      { dir: '3_a', images: 10 },
      { dir: '5_a', images: 10 },
      { dir: '4_b', images: 10 },
      { dir: '2_b', images: 5 },
    ],
    20,
  );
  const byDir = new Map(rows.map((r) => [r.dir, r]));
  assert.match(byDir.get('3_a')!.conflict!, /another folder/);
  assert.match(byDir.get('5_a')!.conflict!, /another folder/);
  assert.match(byDir.get('4_b')!.conflict!, /already exists/);
  assert.equal(byDir.get('2_b')!.newDir, '4_b');
});

test('default target is the largest kohya folder', () => {
  assert.equal(defaultRepeatTarget([{ dir: '3_a', images: 10 }, { dir: '1_b', images: 42 }, { dir: 'x', images: 99 }]), 42);
  assert.equal(defaultRepeatTarget([]), 1);
});

test('plain folders get a repeat prefix when included', () => {
  const folders = [
    { dir: 'dress', images: 10 },
    { dir: 'sets/04_hat', images: 40 },
  ];
  assert.deepEqual(planRepeats(folders, 40).map((r) => r.dir), ['sets/04_hat']);
  const rows = planRepeats(folders, 40, true);
  assert.deepEqual(
    rows.map((r) => [r.dir, r.repeats, r.newDir]),
    [
      ['dress', undefined, '4_dress'],
      ['sets/04_hat', 4, 'sets/01_hat'],
    ],
  );
  assert.equal(defaultRepeatTarget(folders), 40);
  assert.equal(defaultRepeatTarget([{ dir: 'dress', images: 70 }], true), 70);
  assert.equal(isKohyaFolder('a/16_dress'), true);
  assert.equal(isKohyaFolder('dress'), false);
});
