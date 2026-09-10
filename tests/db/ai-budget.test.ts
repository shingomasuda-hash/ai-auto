/**
 * 有料呼出しの予算制御を、実際の呼出し経路で検証する。
 * Anthropic API へは接続せず、fetch を差し替えて応答を模擬する。
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { ensureEnvelopes, getBudgetOverview } from '../../src/db/budget.ts';
import { createMessage } from '../../src/ai/client.ts';
import type { PricingTable } from '../../src/ai/pricing.ts';
import { jstMonthKey } from '../../src/domain/time.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';
const monthKey = jstMonthKey(new Date());

// 1回の呼出しがちょうど 500 円になる料金表。
const TABLE: PricingTable = {
  registered: true, inputPerMTok: 1_000_000, outputPerMTok: 0, currency: 'JPY', fxRateToJpy: 1,
};
const UNREGISTERED: PricingTable = { registered: false, reason: 'fx_rate_unregistered' };

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => {
  mock.restoreAll();
  if (dbAvailable) await teardownDb();
});
beforeEach(async () => {
  if (!dbAvailable) return;
  mock.restoreAll();
  await setupDb();
  ownerId = (await createTestOwner()).id;
  await ensureEnvelopes(ownerId, monthKey);
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
});

function stubFetch(handler: () => Promise<Response> | Response) {
  mock.method(globalThis, 'fetch', async () => handler());
}

function okResponse(inputTokens = 100, outputTokens = 50) {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const call = (key: string, table: PricingTable = TABLE) =>
  createMessage({
    ownerId,
    model: 'test-model',
    system: 'a'.repeat(100),
    userContent: 'b'.repeat(100),
    maxOutputTokens: 100,
    purpose: 'test',
    idempotencyKey: key,
    pricingTable: table,
  });

async function reservedTotal(): Promise<number> {
  const rows = await query<{ total: string }>(
    `SELECT COALESCE(SUM(reserved_yen), 0)::text AS total FROM budget_reservations
      WHERE owner_id = $1 AND state IN ('RESERVED', 'UNSETTLED')`, [ownerId],
  );
  return Number(rows[0].total);
}

test('料金や為替が未登録なら、そもそも呼び出さない', options, async () => {
  let called = 0;
  stubFetch(() => { called += 1; return okResponse(); });

  const result = await call('k1', UNREGISTERED);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'budget_declined');
  assert.equal(called, 0, 'APIを呼んではいけない');
  assert.equal(await reservedTotal(), 0);
});

test('成功したら実績で精算される', options, async () => {
  stubFetch(() => okResponse(2_000_000, 0)); // 実績2円ぶん…ではなく2,000,000/1,000,000*1,000,000
  const result = await call('k1', {
    registered: true, inputPerMTok: 1, outputPerMTok: 0, currency: 'JPY', fxRateToJpy: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.costYen, 2);
  assert.equal(await reservedTotal(), 0, '予約は残らない');

  const overview = await getBudgetOverview(ownerId);
  assert.equal(overview.envelopes.find((e) => e.category === 'ai')!.settledYen, 2);
});

test('4xx は課金なしとして予約を解放する', options, async () => {
  stubFetch(() => new Response('{"error":"bad request"}', { status: 400 }));
  const result = await call('k1');
  assert.equal(!result.ok && result.code, 'api_error');
  assert.equal(await reservedTotal(), 0);
  const states = await query<{ state: string }>(`SELECT state FROM budget_reservations WHERE owner_id = $1`, [ownerId]);
  assert.equal(states[0].state, 'RELEASED');
});

test('5xx は課金有無が不明として予約を保持する', options, async () => {
  stubFetch(() => new Response('upstream error', { status: 503 }));
  const result = await call('k1');
  assert.equal(!result.ok && result.code, 'unknown_billing');
  assert.ok(await reservedTotal() > 0, '予約が残る');
  const states = await query<{ state: string }>(`SELECT state FROM budget_reservations WHERE owner_id = $1`, [ownerId]);
  assert.equal(states[0].state, 'UNSETTLED');
});

test('応答を受け取れなかった場合も予約を解放しない', options, async () => {
  stubFetch(() => { throw new TypeError('fetch failed'); });
  const result = await call('k1');
  assert.equal(!result.ok && result.code, 'unknown_billing');
  const states = await query<{ state: string }>(`SELECT state FROM budget_reservations WHERE owner_id = $1`, [ownerId]);
  assert.equal(states[0].state, 'UNSETTLED');
});

test('APIキーが無ければ呼び出さず、予約を解放する', options, async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let called = 0;
  stubFetch(() => { called += 1; return okResponse(); });
  const result = await call('k1');
  assert.equal(!result.ok && result.code, 'api_error');
  assert.equal(called, 0);
  assert.equal(await reservedTotal(), 0);
});

test('同じ冪等キーでは二重に予約しない', options, async () => {
  stubFetch(() => okResponse(1000, 0));
  await call('same');
  const afterFirst = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM budget_reservations WHERE owner_id = $1`, [ownerId],
  );
  await call('same');
  const afterSecond = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM budget_reservations WHERE owner_id = $1`, [ownerId],
  );
  assert.equal(afterFirst[0].count, afterSecond[0].count, '予約行が増えてはいけない');
});

test('並行して有料呼出ししても予算を超えない', options, async () => {
  // 1回あたり 500円の見込。AI枠は 3,000円 なので 6件までしか通らない。
  const table: PricingTable = {
    registered: true, inputPerMTok: 1_000_000, outputPerMTok: 0, currency: 'JPY', fxRateToJpy: 1,
  };
  // 入力トークン概算が 500 前後になるよう調整する
  const system = 'a'.repeat(150);
  const userContent = 'b'.repeat(150);

  let called = 0;
  stubFetch(async () => {
    called += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return okResponse(0, 0); // 実績0円（予約の効き方を見る）
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      createMessage({
        ownerId, model: 'm', system, userContent, maxOutputTokens: 0,
        purpose: 'race', idempotencyKey: `race-${i}`, pricingTable: table,
      }),
    ),
  );

  const accepted = results.filter((r) => r.ok).length;
  const declined = results.filter((r) => !r.ok && r.code === 'budget_declined').length;

  assert.equal(accepted + declined, 20);
  assert.equal(called, accepted, '予約が通ったぶんだけAPIを呼んでいる');
  assert.ok(accepted > 0 && accepted < 20, `通ったのは ${accepted} 件`);

  const overview = await getBudgetOverview(ownerId);
  const ai = overview.envelopes.find((e) => e.category === 'ai')!;
  assert.ok(ai.committedYen <= ai.limitYen, `枠超過: ${ai.committedYen} > ${ai.limitYen}`);
  assert.ok(
    overview.monthCommittedYen <= overview.monthlyBudgetYen,
    `月次超過: ${overview.monthCommittedYen} > ${overview.monthlyBudgetYen}`,
  );
});

test('未精算が残っていると次の呼出しが枠に阻まれる', options, async () => {
  // すべて 5xx にして「課金有無が不明」な予約を積み上げる。
  stubFetch(() => new Response('err', { status: 500 }));
  let unknownCalls = 0;
  for (let i = 0; i < 50; i += 1) {
    const result = await call(`unknown-${i}`);
    if (!result.ok && result.code === 'budget_declined') break;
    assert.equal(!result.ok && result.code, 'unknown_billing');
    unknownCalls += 1;
  }
  assert.ok(unknownCalls > 0, '少なくとも1件は不明として積まれる');

  const overview = await getBudgetOverview(ownerId);
  assert.equal(overview.unsettledCount, unknownCalls, '不明な呼出しはすべて未精算として残る');
  const ai = overview.envelopes.find((e) => e.category === 'ai')!;
  assert.ok(ai.reservedYen > 0, '予約が枠を塞いでいる');
  assert.ok(ai.committedYen <= ai.limitYen);

  // 枠が埋まったので、次の呼出しはAPIに到達しない。
  let called = 0;
  stubFetch(() => { called += 1; return okResponse(); });
  const blocked = await call('after');
  assert.equal(!blocked.ok && blocked.code, 'budget_declined');
  assert.equal(called, 0, '予約できない呼出しはAPIを叩かない');
});

test('未精算を手動で精算すると枠が戻る', options, async () => {
  stubFetch(() => new Response('err', { status: 500 }));
  const first = await call('unknown-1');
  assert.equal(!first.ok && first.code, 'unknown_billing');

  const before = await getBudgetOverview(ownerId);
  const reservedBefore = before.envelopes.find((e) => e.category === 'ai')!.reservedYen;
  assert.ok(reservedBefore > 0);

  // 提供元の明細で「課金されていなかった」と確認できた場合の手当て。
  await query(
    `UPDATE budget_reservations SET state = 'RELEASED', reserved_yen = 0, settled_at = now()
      WHERE owner_id = $1 AND state = 'UNSETTLED'`, [ownerId],
  );

  const after = await getBudgetOverview(ownerId);
  assert.equal(after.unsettledCount, 0);
  assert.equal(after.envelopes.find((e) => e.category === 'ai')!.reservedYen, 0);
});
