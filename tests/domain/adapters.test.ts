import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHttpStatus, classifyTransportError, RateLimitError, TokenExpiredError,
} from '../../src/adapters/types.ts';
import { createSimulatedAdapter } from '../../src/adapters/simulated.ts';

test('2xx は成功', () => {
  assert.equal(classifyHttpStatus(200), 'ok');
  assert.equal(classifyHttpStatus(201), 'ok');
});

test('4xx は「受け付けられなかった」ことが明確', () => {
  assert.equal(classifyHttpStatus(400), 'failed');
  assert.equal(classifyHttpStatus(404), 'failed');
  assert.equal(classifyHttpStatus(422), 'failed');
});

test('認可エラーとレート制限は別扱い', () => {
  assert.equal(classifyHttpStatus(401), 'auth');
  assert.equal(classifyHttpStatus(403), 'auth');
  assert.equal(classifyHttpStatus(429), 'rate_limited');
});

test('5xx は送信済みか判断できないので unknown', () => {
  assert.equal(classifyHttpStatus(500), 'unknown');
  assert.equal(classifyHttpStatus(502), 'unknown');
  assert.equal(classifyHttpStatus(503), 'unknown');
  assert.equal(classifyHttpStatus(504), 'unknown');
});

test('タイムアウトは unknown に倒す', () => {
  const aborted = classifyTransportError(new DOMException('timeout', 'AbortError'));
  assert.equal(aborted.unknown, true);
  assert.equal(aborted.code, 'timeout');
});

test('接続エラーも unknown に倒す', () => {
  const network = classifyTransportError(new TypeError('fetch failed'));
  assert.equal(network.unknown, true);
});

test('トークン失効とレート制限は unknown ではない', () => {
  assert.equal(classifyTransportError(new TokenExpiredError('expired')).unknown, false);
  assert.equal(classifyTransportError(new RateLimitError(1000, 'too many')).unknown, false);
  assert.equal(new RateLimitError(5000, 'x').retryAfterMs, 5000);
});

test('模擬接続は外部へ送らず、同じ鍵で同じIDを返す', async () => {
  const adapter = createSimulatedAdapter('x');
  assert.equal(adapter.mode, 'simulated');
  const signal = new AbortController().signal;
  const first = await adapter.publish({ idempotencyKey: 'k1', body: 'a', providerState: {}, signal });
  const second = await adapter.publish({ idempotencyKey: 'k1', body: 'a', providerState: {}, signal });
  assert.equal(first.outcome, 'PUBLISHED');
  assert.equal(
    first.outcome === 'PUBLISHED' && second.outcome === 'PUBLISHED'
      ? first.externalPostId === second.externalPostId : false,
    true,
  );
  const other = await adapter.publish({ idempotencyKey: 'k2', body: 'a', providerState: {}, signal });
  assert.notEqual(
    first.outcome === 'PUBLISHED' ? first.externalPostId : '',
    other.outcome === 'PUBLISHED' ? other.externalPostId : '',
  );
});
