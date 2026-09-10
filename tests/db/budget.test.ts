import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { ensureEnvelopes, reserveBudget, settleReservation, getBudgetOverview } from '../../src/db/budget.ts';
import { jstMonthKey } from '../../src/domain/time.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';
const now = new Date();
const monthKey = jstMonthKey(now);

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerId = (await createTestOwner()).id;
  await ensureEnvelopes(ownerId, monthKey);
});

const reserve = (estimateYen: number, key: string, retryFactor = 1) =>
  reserveBudget({
    ownerId,
    category: 'ai',
    pricing: { known: true, estimateYen },
    retryFactor,
    purpose: 'test',
    idempotencyKey: key,
    now,
  });

async function reservedTotal(): Promise<number> {
  const rows = await query<{ total: string }>(
    `SELECT COALESCE(SUM(reserved_yen), 0)::text AS total
       FROM budget_reservations
      WHERE owner_id = $1 AND state IN ('RESERVED', 'UNSETTLED')`,
    [ownerId],
  );
  return Number(rows[0].total);
}

test('枠の範囲内なら予約できる', options, async () => {
  const result = await reserve(500, 'k1');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.reservation.reserved_yen, 500);
});

test('リトライ分を含めた見込額で予約する', options, async () => {
  const result = await reserve(500, 'k1', 3);
  assert.equal(result.ok && result.reservation.reserved_yen, 1500);
});

test('同じ冪等キーでは二重に予約しない', options, async () => {
  const first = await reserve(500, 'same-key');
  const second = await reserve(500, 'same-key');
  assert.equal(first.ok && second.ok, true);
  assert.equal(second.ok && second.reusedExisting, true);
  assert.equal(await reservedTotal(), 500);
});

test('枠を超える予約は拒否する', options, async () => {
  assert.equal((await reserve(2900, 'k1')).ok, true);
  const rejected = await reserve(200, 'k2');
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.decision.code, 'envelope_exceeded');
  assert.equal(await reservedTotal(), 2900);
});

test('料金が未登録なら予約せず止める', options, async () => {
  const result = await reserveBudget({
    ownerId,
    category: 'ai',
    pricing: { known: false, reason: 'fx_rate_unregistered' },
    retryFactor: 1,
    purpose: 'test',
    idempotencyKey: 'k1',
    now,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.decision.code, 'pricing_unknown');
  assert.equal(await reservedTotal(), 0);
});

test('予算枠が未設定の月は有料処理を通さない', options, async () => {
  const other = (await createTestOwner()).id; // ensureEnvelopes していない
  const result = await reserveBudget({
    ownerId: other,
    category: 'ai',
    pricing: { known: true, estimateYen: 10 },
    retryFactor: 1,
    purpose: 'test',
    idempotencyKey: 'k1',
    now,
  });
  assert.equal(result.ok, false);
});

test('並行して予約しても枠を超えない', options, async () => {
  // 枠3,000円に対して 400円 × 20件 を同時に投げる。通るのは7件まで。
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => reserve(400, `race-${i}`)),
  );

  const accepted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  assert.equal(accepted.length, 7, `通ったのは ${accepted.length} 件`);
  assert.equal(rejected.length, 13);
  assert.equal(await reservedTotal(), 2800);

  const overview = await getBudgetOverview(ownerId, now);
  const ai = overview.envelopes.find((e) => e.category === 'ai')!;
  assert.ok(ai.committedYen <= ai.limitYen, `committed=${ai.committedYen} limit=${ai.limitYen}`);
});

test('並行予約が月次総額も超えない', options, async () => {
  // すべての枠を使い切る方向に、4枠へ同時に投げる。
  const categories = ['ai', 'x_api', 'infra', 'reserve'] as const;
  const calls = [];
  for (const category of categories) {
    for (let i = 0; i < 10; i += 1) {
      calls.push(
        reserveBudget({
          ownerId,
          category,
          pricing: { known: true, estimateYen: 400 },
          retryFactor: 1,
          purpose: 'test',
          idempotencyKey: `${category}-${i}`,
          now,
        }),
      );
    }
  }
  await Promise.all(calls);

  const overview = await getBudgetOverview(ownerId, now);
  assert.ok(
    overview.monthCommittedYen <= overview.monthlyBudgetYen,
    `月次確定 ${overview.monthCommittedYen} が予算 ${overview.monthlyBudgetYen} を超えた`,
  );
});

test('成功時は実績で精算し、余りが枠へ戻る', options, async () => {
  const reserved = await reserve(1000, 'k1');
  assert.equal(reserved.ok, true);
  const settled = await settleReservation(reserved.ok ? reserved.reservation.id : '', {
    kind: 'success',
    actualYen: 300,
  });
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.settled_yen, 300);
  assert.equal(await reservedTotal(), 0);

  const overview = await getBudgetOverview(ownerId, now);
  const ai = overview.envelopes.find((e) => e.category === 'ai')!;
  assert.equal(ai.settledYen, 300);
  assert.equal(ai.reservedYen, 0);
  assert.equal(ai.availableYen, 2700);
});

test('課金なしが確実な失敗なら予約を解放する', options, async () => {
  const reserved = await reserve(1000, 'k1');
  const settled = await settleReservation(reserved.ok ? reserved.reservation.id : '', { kind: 'failed_not_charged' });
  assert.equal(settled.state, 'RELEASED');
  assert.equal(await reservedTotal(), 0);
});

test('課金有無が不明な失敗では予約を解放しない', options, async () => {
  const reserved = await reserve(1000, 'k1');
  const settled = await settleReservation(reserved.ok ? reserved.reservation.id : '', { kind: 'failed_unknown' });
  assert.equal(settled.state, 'UNSETTLED');
  assert.equal(settled.settled_yen, 0);
  // 枠は塞がったままで、次の予約に影響する
  assert.equal(await reservedTotal(), 1000);
  const overview = await getBudgetOverview(ownerId, now);
  assert.equal(overview.envelopes.find((e) => e.category === 'ai')!.availableYen, 2000);
  assert.equal(overview.unsettledCount, 1);
});

test('固定費は先に差し引かれる', options, async () => {
  await query(
    `UPDATE budget_envelopes SET fixed_yen = 2500 WHERE owner_id = $1 AND month_key = $2 AND category = 'ai'`,
    [ownerId, monthKey],
  );
  assert.equal((await reserve(400, 'k1')).ok, true);
  const rejected = await reserve(200, 'k2');
  assert.equal(rejected.ok, false);
});

test('80%を超えたら警告フラグが立つ', options, async () => {
  await reserve(2400, 'k1');
  const overview = await getBudgetOverview(ownerId, now);
  assert.equal(overview.envelopes.find((e) => e.category === 'ai')!.warn, true);
});

test('他人の予算枠へは予約できない', options, async () => {
  const other = (await createTestOwner()).id;
  await ensureEnvelopes(other, monthKey);
  await reserve(2900, 'k1');
  // 自分の枠は埋まっているが、他人の枠は影響を受けない
  const otherResult = await reserveBudget({
    ownerId: other,
    category: 'ai',
    pricing: { known: true, estimateYen: 2900 },
    retryFactor: 1,
    purpose: 'test',
    idempotencyKey: 'k1',
    now,
  });
  assert.equal(otherResult.ok, true);
});
