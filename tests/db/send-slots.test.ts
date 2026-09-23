/**
 * 送信枠の予約を検証する。
 *
 * 検査と送信のあいだに割り込まれると運営上限が破れる。
 * 同時に走っても枠が二重に取れないことを、実際の並行実行で確かめる。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { reserveSendSlot, releaseSendSlot, countRecentSlots } from '../../src/db/send-slots.ts';
import { POLICY } from '../../src/domain/policy.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';
const now = new Date('2026-04-10T12:00:00Z');

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerId = (await createTestOwner()).id;
});

const reserve = (at: Date = now, platform: 'threads' | 'x' = 'threads') =>
  reserveSendSlot(ownerId, platform, null as unknown as string, at);

test('最初の枠は取れる', options, async () => {
  const result = await reserve();
  assert.equal(result.ok, true);
  assert.equal(await countRecentSlots(ownerId, 'threads', now), 1);
});

test('2時間あいていなければ取れない', options, async () => {
  await reserve(now);
  const tooSoon = await reserve(new Date(now.getTime() + POLICY.minIntervalMs - 1000));
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.ok === false && tooSoon.code, 'min_interval');
  assert.equal(
    tooSoon.ok === false && tooSoon.retryAt.toISOString(),
    new Date(now.getTime() + POLICY.minIntervalMs).toISOString(),
  );
});

test('2時間ちょうどなら取れる', options, async () => {
  await reserve(now);
  const ok = await reserve(new Date(now.getTime() + POLICY.minIntervalMs));
  assert.equal(ok.ok, true);
});

test('24時間で3件を超えると取れない', options, async () => {
  const base = now.getTime();
  for (let i = 0; i < POLICY.maxPostsPerPlatformPer24h; i += 1) {
    const at = new Date(base + i * POLICY.minIntervalMs);
    assert.equal((await reserve(at)).ok, true, `${i}件目`);
  }
  // 間隔は足りているが、窓の中に3件ある
  const fourth = await reserve(new Date(base + 3 * POLICY.minIntervalMs));
  assert.equal(fourth.ok, false);
  assert.equal(fourth.ok === false && fourth.code, 'rate_limited');
  // 最も古い1件が窓から抜ける時刻まで待つ
  assert.equal(
    fourth.ok === false && fourth.retryAt.toISOString(),
    new Date(base + POLICY.rateWindowMs).toISOString(),
  );
});

test('窓から抜ければまた取れる', options, async () => {
  const base = now.getTime();
  for (let i = 0; i < 3; i += 1) await reserve(new Date(base + i * POLICY.minIntervalMs));
  const later = new Date(base + POLICY.rateWindowMs + 1000);
  assert.equal((await reserve(later)).ok, true);
});

test('媒体ごとに独立している', options, async () => {
  await reserve(now, 'threads');
  const x = await reserve(now, 'x');
  assert.equal(x.ok, true, 'Threadsの枠がXを塞いでいる');
});

test('所有者ごとに独立している', options, async () => {
  const other = await createTestOwner();
  await reserve(now);
  const result = await reserveSendSlot(other.id, 'threads', null as unknown as string, now);
  assert.equal(result.ok, true, '他人の枠が塞いでいる');
});

test('同時に取りに行っても1つしか取れない', options, async () => {
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () => reserve(new Date())),
  );
  const won = attempts.filter((r) => r.ok);
  assert.equal(won.length, 1, `${won.length} 個の枠が取れてしまった`);
  assert.equal(await countRecentSlots(ownerId, 'threads'), 1);
});

test('同時でも24時間の上限を超えない', options, async () => {
  // 窓の中に2件すでにある状態で、10並列で取りに行く
  const base = Date.now();
  await query(
    `INSERT INTO send_slot_reservations (owner_id, platform, reserved_at)
     VALUES ($1,'threads',$2), ($1,'threads',$3)`,
    [ownerId, new Date(base - 20 * 3_600_000), new Date(base - 10 * 3_600_000)],
  );
  const attempts = await Promise.all(Array.from({ length: 10 }, () => reserve(new Date())));
  const won = attempts.filter((r) => r.ok);
  assert.equal(won.length, 1, '上限を超えて枠が取れた');
  assert.equal(await countRecentSlots(ownerId, 'threads'), 3);
});

test('枠は明示的に返すまで残る', options, async () => {
  const result = await reserve(now);
  assert.equal(result.ok, true);
  assert.equal(await countRecentSlots(ownerId, 'threads', now), 1);

  // 外部へ届いていないことが確実な場合にだけ返す
  await releaseSendSlot(result.ok ? result.reservationId : '');
  assert.equal(await countRecentSlots(ownerId, 'threads', now), 0);
  assert.equal((await reserve(now)).ok, true, '返した枠が再利用できない');
});
