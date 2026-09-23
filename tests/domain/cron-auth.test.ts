import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCron } from '../../src/lib/cron-auth.ts';

const SECRET = 'a-sufficiently-long-cron-secret';
const original = process.env.CRON_SECRET;

beforeEach(() => { process.env.CRON_SECRET = SECRET; });
afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = original;
});

const headers = (init: Record<string, string>) => new Headers(init);

test('CRON_SECRET が未設定なら誰も通さない', () => {
  delete process.env.CRON_SECRET;
  const result = authorizeCron(headers({ authorization: `Bearer ${SECRET}` }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 503);
  assert.match(result.ok === false ? result.reason : '', /未設定/);
});

test('短すぎる CRON_SECRET は設定されていない扱い', () => {
  process.env.CRON_SECRET = 'short';
  const result = authorizeCron(headers({ authorization: 'Bearer short' }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 503);
});

test('Vercel 形式の Authorization: Bearer を受ける', () => {
  assert.deepEqual(authorizeCron(headers({ authorization: `Bearer ${SECRET}` })), { ok: true });
});

test('外部cron向けに x-cron-secret も受ける', () => {
  assert.deepEqual(authorizeCron(headers({ 'x-cron-secret': SECRET })), { ok: true });
});

test('秘密が違えば通さない', () => {
  const wrong = authorizeCron(headers({ authorization: 'Bearer wrong-but-long-enough-value' }));
  assert.equal(wrong.ok === false && wrong.status, 401);
  const wrongHeader = authorizeCron(headers({ 'x-cron-secret': 'wrong-but-long-enough-value' }));
  assert.equal(wrongHeader.ok === false && wrongHeader.status, 401);
});

test('秘密が無ければ通さない', () => {
  const result = authorizeCron(headers({}));
  assert.equal(result.ok === false && result.status, 401);
});

test('Bearer の前置きが無い Authorization は無視する', () => {
  // `Authorization: <secret>` のような形は受け付けない
  const result = authorizeCron(headers({ authorization: SECRET }));
  assert.equal(result.ok, false);
});

test('前方一致では通らない', () => {
  const result = authorizeCron(headers({ 'x-cron-secret': SECRET.slice(0, -1) }));
  assert.equal(result.ok === false && result.status, 401);
});

test('余計な文字が付いていても通らない', () => {
  const result = authorizeCron(headers({ 'x-cron-secret': `${SECRET}x` }));
  assert.equal(result.ok === false && result.status, 401);
});
