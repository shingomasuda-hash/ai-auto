import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY, checkSchedule, isExpired, isClaimExpired,
  evaluateSendGate, normalizeForDuplicate, findDuplicate,
} from '../../src/domain/policy.ts';
import type { ScheduledLike } from '../../src/domain/policy.ts';

const now = new Date('2026-04-01T00:00:00Z'); // JST 09:00

test('運営上限は媒体ごとに1日3件', () => {
  const existing: ScheduledLike[] = [
    { id: 'a', platform: 'x', at: new Date('2026-04-01T01:00:00Z') },
    { id: 'b', platform: 'x', at: new Date('2026-04-01T04:00:00Z') },
    { id: 'c', platform: 'x', at: new Date('2026-04-01T07:00:00Z') },
  ];
  const violations = checkSchedule({ platform: 'x', at: new Date('2026-04-01T10:00:00Z'), existing, now });
  assert.equal(violations.some((v) => v.code === 'daily_limit'), true);

  // 別媒体は独立して数える
  assert.deepEqual(checkSchedule({ platform: 'threads', at: new Date('2026-04-01T10:00:00Z'), existing, now }), []);
});

test('JSTの日付が変わればカウントし直す', () => {
  const existing: ScheduledLike[] = [
    { id: 'a', platform: 'x', at: new Date('2026-04-01T05:00:00Z') },
    { id: 'b', platform: 'x', at: new Date('2026-04-01T08:00:00Z') },
    { id: 'c', platform: 'x', at: new Date('2026-04-01T11:00:00Z') },
  ];
  // 2026-04-01T15:00Z は JST 2026-04-02 00:00
  const violations = checkSchedule({ platform: 'x', at: new Date('2026-04-01T15:00:00Z'), existing, now });
  assert.equal(violations.some((v) => v.code === 'daily_limit'), false);
});

test('同一媒体は2時間以上あける', () => {
  const existing: ScheduledLike[] = [{ id: 'a', platform: 'x', at: new Date('2026-04-01T03:00:00Z') }];
  const tooClose = checkSchedule({ platform: 'x', at: new Date('2026-04-01T04:30:00Z'), existing, now });
  assert.equal(tooClose.some((v) => v.code === 'min_interval'), true);
  const justOk = checkSchedule({ platform: 'x', at: new Date('2026-04-01T05:00:00Z'), existing, now });
  assert.equal(justOk.some((v) => v.code === 'min_interval'), false);
  // 前方向にも効く
  const before = checkSchedule({ platform: 'x', at: new Date('2026-04-01T02:00:00Z'), existing, now });
  assert.equal(before.some((v) => v.code === 'min_interval'), true);
});

test('過去の時刻は予約できない', () => {
  const violations = checkSchedule({ platform: 'x', at: new Date('2026-03-31T23:00:00Z'), existing: [], now });
  assert.equal(violations.some((v) => v.code === 'in_past'), true);
});

test('違反は最初の1件で打ち切らずすべて返す', () => {
  const existing: ScheduledLike[] = [
    { id: 'a', platform: 'x', at: new Date('2026-03-31T20:00:00Z') },
    { id: 'b', platform: 'x', at: new Date('2026-03-31T22:00:00Z') },
    { id: 'c', platform: 'x', at: new Date('2026-03-31T18:00:00Z') },
  ];
  const violations = checkSchedule({ platform: 'x', at: new Date('2026-03-31T23:00:00Z'), existing, now });
  const codes = violations.map((v) => v.code).sort();
  assert.deepEqual(codes, ['daily_limit', 'in_past', 'min_interval']);
});

test('24時間を過ぎた予約は期限切れ', () => {
  const scheduled = new Date('2026-04-01T00:00:00Z');
  assert.equal(isExpired(scheduled, new Date('2026-04-01T23:59:00Z')), false);
  assert.equal(isExpired(scheduled, new Date('2026-04-02T00:00:01Z')), true);
});

test('claimのリース期限', () => {
  const claimedAt = new Date('2026-04-01T00:00:00Z');
  assert.equal(isClaimExpired(claimedAt, new Date('2026-04-01T00:04:00Z')), false);
  assert.equal(isClaimExpired(claimedAt, new Date('2026-04-01T00:06:00Z')), true);
  assert.equal(POLICY.claimLeaseMs, 5 * 60_000);
});

const baseGate = {
  platform: 'x' as const,
  body: 'テスト本文',
  scheduledAt: new Date('2026-04-01T00:00:00Z'),
  now: new Date('2026-04-01T00:00:10Z'),
  globalStop: false,
  platformStop: false,
  connectionMode: 'live' as const,
};

test('送信直前ゲート: 停止が最優先', () => {
  assert.equal(evaluateSendGate({ ...baseGate, globalStop: true }).allowed, false);
  assert.equal(evaluateSendGate({ ...baseGate, platformStop: true }).allowed, false);
  const stopped = evaluateSendGate({ ...baseGate, globalStop: true });
  assert.equal(stopped.allowed === false && stopped.code, 'stopped');
});

test('送信直前ゲート: 未接続では送らない', () => {
  const result = evaluateSendGate({ ...baseGate, connectionMode: 'disconnected' });
  assert.equal(result.allowed === false && result.code, 'not_connected');
});

test('送信直前ゲート: 期限切れ・長すぎ・空を弾く', () => {
  const expired = evaluateSendGate({ ...baseGate, now: new Date('2026-04-02T01:00:00Z') });
  assert.equal(expired.allowed === false && expired.code, 'expired');
  const tooLong = evaluateSendGate({ ...baseGate, body: 'あ'.repeat(141) });
  assert.equal(tooLong.allowed === false && tooLong.code, 'too_long');
  const empty = evaluateSendGate({ ...baseGate, body: '   ' });
  assert.equal(empty.allowed === false && empty.code, 'empty');
});

test('送信直前ゲート: 条件が揃えば許可', () => {
  assert.deepEqual(evaluateSendGate(baseGate), { allowed: true });
});

test('重複検出は全角/半角・大小文字・記号・URLの違いを吸収する', () => {
  assert.equal(
    normalizeForDuplicate('AIで、Web制作！ https://ex.com #tag'),
    normalizeForDuplicate('ＡＩで Ｗｅｂ制作 https://other.example/different ＃tag'),
  );
});

test('重複検出は語の区切りの違いまでは吸収しない', () => {
  // 空白の有無は意味が変わりうるので同一視しない
  assert.notEqual(normalizeForDuplicate('AIで制作'), normalizeForDuplicate('AI で制作'));
});

test('重複検出は期間外を無視する', () => {
  const existing = [{ id: 'old', body: '同じ本文です', at: new Date('2026-01-01T00:00:00Z') }];
  assert.equal(findDuplicate('同じ本文です', existing, now), null);
  const recent = [{ id: 'r', body: '同じ本文です', at: new Date('2026-03-25T00:00:00Z') }];
  assert.equal(findDuplicate('同じ本文です', recent, now)?.id, 'r');
});

test('空文字は重複扱いしない', () => {
  assert.equal(findDuplicate('   ', [{ id: 'x', body: '  ', at: now }], now), null);
});
