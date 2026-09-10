import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightedLengthX, lengthThreads, checkLength, X_CONFIG, THREADS_CONFIG } from '../../src/domain/text-length.ts';

test('Xはラテン文字を1、CJKを2として数える', () => {
  assert.equal(weightedLengthX('a'.repeat(280)), 280);
  assert.equal(weightedLengthX('あ'.repeat(140)), 280);
  assert.equal(weightedLengthX('abcあいう'), 3 + 6);
});

test('XのURLは実長に関わらず23', () => {
  assert.equal(weightedLengthX('https://x.co/a'), X_CONFIG.transformedUrlLength);
  assert.equal(weightedLengthX('https://example.com/' + 'a'.repeat(300)), X_CONFIG.transformedUrlLength);
  assert.equal(weightedLengthX('見て https://example.com/長いパス'), 2 * 2 + 1 + 23);
});

test('Xの結合絵文字は1文字(=2)として数える', () => {
  assert.equal(weightedLengthX('👨‍👩‍👧‍👦'), 2);
  assert.equal(weightedLengthX('🇯🇵'), 2);
});

test('X上限280の境界', () => {
  assert.equal(checkLength('x', 'あ'.repeat(140)).ok, true);
  assert.equal(checkLength('x', 'あ'.repeat(141)).ok, false);
  assert.equal(checkLength('x', 'あ'.repeat(141)).remaining, -2);
});

test('Threadsは500文字、数え方は安全側の符号位置', () => {
  assert.equal(THREADS_CONFIG.maxLength, 500);
  assert.equal(lengthThreads('あ'.repeat(500)), 500);
  assert.equal(checkLength('threads', 'あ'.repeat(500)).ok, true);
  assert.equal(checkLength('threads', 'あ'.repeat(501)).ok, false);
  // 結合絵文字は多め(=安全側)に数えられる
  assert.equal(lengthThreads('👨‍👩‍👧‍👦'), 7);
});

test('空文字・空白のみは不可', () => {
  assert.equal(checkLength('x', '').ok, false);
  assert.equal(checkLength('threads', '   \n ').ok, false);
});
