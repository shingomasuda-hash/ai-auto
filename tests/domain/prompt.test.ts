import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissingInputError } from '../../src/lib/prompt.ts';

test('入力不足は専用のエラーになる', () => {
  const error = new MissingInputError('パスワード');
  assert.equal(error.name, 'MissingInputError');
  assert.match(error.message, /入力が足りません/);
  assert.match(error.message, /パスワード/);
});
