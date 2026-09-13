import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissingInputError, InputAbortedError, applySecretKey } from '../../src/lib/prompt.ts';

const BS = '\u007f';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const ESC = '\u001b';

test('入力不足は専用のエラーになる', () => {
  const error = new MissingInputError('パスワード');
  assert.equal(error.name, 'MissingInputError');
  assert.match(error.message, /入力が足りません/);
  assert.match(error.message, /パスワード/);
});

/** 文字を1つずつ流し込み、画面へ出た内容と確定値を返す。 */
function type(input: string): { echoed: string; value: string | null; aborted: boolean } {
  const chars: string[] = [];
  let echoed = '';
  for (const char of input) {
    const result = applySecretKey(chars, char);
    if (result.kind === 'done') return { echoed, value: result.value, aborted: false };
    if (result.kind === 'aborted') return { echoed, value: null, aborted: true };
    echoed += result.echo;
  }
  return { echoed, value: null, aborted: false };
}

test('入力した文字は画面へ出ず、伏せ字だけが出る', () => {
  const result = type('Shin08047190\r');
  assert.equal(result.value, 'Shin08047190', '値は正しく組み立てられる');
  assert.equal(result.echoed, '*'.repeat(12), '画面には伏せ字だけ');
  assert.doesNotMatch(result.echoed, /Shin/, 'パスワードが画面へ出ている');
  assert.doesNotMatch(result.echoed, /[0-9]/, '数字が画面へ出ている');
});

test('バックスペースで1文字ずつ消える', () => {
  const result = type(`abcXX${BS}${BS}def\r`);
  assert.equal(result.value, 'abcdef');
  assert.doesNotMatch(result.echoed, /[a-z]/, '値が画面へ出ている');
});

test('何も入力していないときのバックスペースは何もしない', () => {
  const result = type(`${BS}${BS}ab\r`);
  assert.equal(result.value, 'ab');
  assert.equal(result.echoed, '**');
});

test('Enter(改行/復帰)のどちらでも確定する', () => {
  assert.equal(type('pw\r').value, 'pw');
  assert.equal(type('pw\n').value, 'pw');
});

test('空のまま確定できる（長さの検証は呼び出し側で行う）', () => {
  assert.equal(type('\r').value, '');
});

test('Ctrl-C / Ctrl-D で中断する', () => {
  assert.equal(type(`abc${CTRL_C}`).aborted, true);
  assert.equal(type(`abc${CTRL_D}`).aborted, true);
  assert.equal(type(`abc${CTRL_C}`).value, null);
});

test('矢印キーなどの制御文字は値に混ざらない', () => {
  // 上矢印 = ESC [ A
  const result = type(`ab${ESC}[Acd\r`);
  assert.equal(result.value?.includes(ESC), false, 'ESCが値に入っている');
  assert.equal(result.value, 'ab[Acd');
});

test('記号や日本語も扱える', () => {
  assert.equal(type('a!#$%&-_+=@\r').value, 'a!#$%&-_+=@');
  assert.equal(type('パスワード123\r').value, 'パスワード123');
});

test('中断のエラーは専用の型', () => {
  const error = new InputAbortedError();
  assert.equal(error.name, 'InputAbortedError');
  assert.match(error.message, /中断/);
});
