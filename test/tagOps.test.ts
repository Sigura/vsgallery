import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTagOp, tagOpCreates, validateTagOp } from '../src/shared/tagOps';

test('rename keeps position and spelling of the new tag', () => {
  assert.equal(applyTagOp('a, old tag, c', { kind: 'rename', from: 'Old Tag', to: 'new tag' }), 'a, new tag, c');
  assert.equal(applyTagOp('a, c', { kind: 'rename', from: 'old', to: 'new' }), undefined);
});

test('rename onto an existing tag merges at the earlier position', () => {
  assert.equal(applyTagOp('x, cat, y, kitty', { kind: 'rename', from: 'kitty', to: 'cat' }), 'x, cat, y');
  assert.equal(applyTagOp('kitty, x, cat', { kind: 'rename', from: 'kitty', to: 'cat' }), 'cat, x');
  assert.equal(applyTagOp('Cat, x', { kind: 'rename', from: 'Cat', to: 'cat' }), 'cat, x');
});

test('remove drops every case-insensitive match', () => {
  assert.equal(applyTagOp('a, B, c, b', { kind: 'remove', tag: 'b' }), 'a, c');
  assert.equal(applyTagOp('a, c', { kind: 'remove', tag: 'b' }), undefined);
  assert.equal(applyTagOp('b', { kind: 'remove', tag: 'b' }), '');
  assert.equal(applyTagOp(null, { kind: 'remove', tag: 'b' }), undefined);
});

test('add at start or end unless present; creates missing captions', () => {
  assert.equal(applyTagOp('a, b', { kind: 'add', tag: ' new  tag ', at: 'start' }), 'new tag, a, b');
  assert.equal(applyTagOp('a, b', { kind: 'add', tag: 'z', at: 'end' }), 'a, b, z');
  assert.equal(applyTagOp('a, Z', { kind: 'add', tag: 'z', at: 'end' }), undefined);
  assert.equal(applyTagOp(null, { kind: 'add', tag: 'z', at: 'end' }), 'z');
  assert.equal(applyTagOp('', { kind: 'add', tag: 'z', at: 'start' }), 'z');
});

test('first moves the trigger word to the front or inserts it', () => {
  assert.equal(applyTagOp('a, b, TRIG', { kind: 'first', tag: 'trig' }), 'TRIG, a, b');
  assert.equal(applyTagOp('trig, a', { kind: 'first', tag: 'trig' }), undefined);
  assert.equal(applyTagOp('a, b', { kind: 'first', tag: 'trig' }), 'trig, a, b');
  assert.equal(applyTagOp(null, { kind: 'first', tag: 'trig' }), 'trig');
});

test('an unchanged tag list leaves formatting alone', () => {
  assert.equal(applyTagOp('a,b ,  c\n', { kind: 'remove', tag: 'zzz' }), undefined);
  assert.equal(applyTagOp('a,b ,  c\n', { kind: 'remove', tag: 'b' }), 'a, c');
});

test('validation and creation rules', () => {
  assert.equal(validateTagOp({ kind: 'rename', from: 'a', to: 'b' }), undefined);
  assert.ok(validateTagOp({ kind: 'rename', from: 'a', to: ' a ' }));
  assert.ok(validateTagOp({ kind: 'rename', from: '', to: 'b' }));
  assert.ok(validateTagOp({ kind: 'add', tag: 'a, b', at: 'end' }));
  assert.ok(validateTagOp({ kind: 'remove', tag: '  ' }));
  assert.equal(tagOpCreates({ kind: 'remove', tag: 'x' }), false);
  assert.equal(tagOpCreates({ kind: 'first', tag: 'x' }), true);
});
