/**
 * キットの純粋関数(src/domain/policy.mjs)と、アプリ側の実装が
 * 同じ判断をするかを突き合わせる。
 *
 * 同じ規則を二箇所に書いている以上、放っておけば必ずずれる。
 * ここで「安全側の不変条件」を両者に対して同時に確かめる。
 *
 * 意図的に違う点は tests/kit/DIFFERENCES.md に記録する。
 * ここで失敗したら、どちらが正しいかを決めてから直すこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { revenueSummary, budgetDecision, transition, scheduleDecision } from '../../src/domain/policy.mjs';
import { computeProfit } from '../../src/domain/money.ts';
import { decideReservation } from '../../src/domain/budget.ts';
import { canTransition } from '../../src/domain/post-state.ts';
import type { PostState, TransitionActor } from '../../src/domain/post-state.ts';
import { POST_STATES } from '../../src/domain/post-state.ts';
import { POLICY, evaluateSendGate } from '../../src/domain/policy.ts';

const ACTORS: TransitionActor[] = ['owner', 'worker', 'reconciler', 'scheduler'];

/** どの担当でも許されないなら、その遷移は禁止。 */
function forbiddenForEveryone(from: PostState, to: PostState): boolean {
  return ACTORS.every((actor) => !canTransition(from, to, actor).ok);
}

test('利益の計算が一致する', () => {
  const cases = [
    { grossYen: 392000, refundsYen: 0, feesYen: 78400, operatingYen: 10000 },
    { grossYen: 9800, refundsYen: 1980, feesYen: 1470, operatingYen: 3000 },
    { grossYen: 0, refundsYen: 0, feesYen: 0, operatingYen: 0 },
  ];
  for (const c of cases) {
    const kit = revenueSummary(c);
    const app = computeProfit({
      grossSalesYen: c.grossYen,
      refundsYen: c.refundsYen,
      platformFeesYen: c.feesYen,
      operatingCostsYen: c.operatingYen,
    });
    assert.equal(app.netSalesYen, kit.netSalesYen, JSON.stringify(c));
    assert.equal(app.pretaxProfitYen, kit.profitYen, JSON.stringify(c));
  }
});

test('手数料が不明なら、どちらも利益を確定しない', () => {
  assert.equal(revenueSummary({ grossYen: 9800 }).profitYen, null);
  assert.equal(
    computeProfit({ grossSalesYen: 9800, refundsYen: 0, platformFeesYen: null, operatingCostsYen: 0 }).pretaxProfitYen,
    null,
  );
});

test('予算の可否が一致する', () => {
  const cases = [
    { spent: 8000, reserved: 1500, estimate: 501, expected: false },
    { spent: 8000, reserved: 1000, estimate: 1000, expected: true },  // ちょうど上限は通る
    { spent: 0, reserved: 0, estimate: 0, expected: true },
    { spent: 9999, reserved: 0, estimate: 2, expected: false },
  ];
  for (const c of cases) {
    const kit = budgetDecision({
      capYen: 10000, spentYen: c.spent, reservedYen: c.reserved, estimateYen: c.estimate,
    });
    const app = decideReservation({
      envelope: {
        category: 'ai', limitYen: 10000, settledYen: c.spent, reservedYen: c.reserved, fixedYen: 0,
      },
      monthCommittedYen: c.spent + c.reserved,
      monthlyBudgetYen: 10000,
      pricing: { known: true, estimateYen: c.estimate },
      retryFactor: 1,
    });
    assert.equal(kit.allowed, c.expected, `kit: ${JSON.stringify(c)}`);
    assert.equal(app.allowed, c.expected, `app: ${JSON.stringify(c)}`);
  }
});

test('料金が不明なら、どちらも有料処理を許可しない', () => {
  assert.equal(
    budgetDecision({ capYen: 10000, spentYen: 0, reservedYen: 0, estimateYen: 0, pricingKnown: false }).allowed,
    false,
  );
  assert.equal(
    decideReservation({
      envelope: { category: 'ai', limitYen: 10000, settledYen: 0, reservedYen: 0, fixedYen: 0 },
      monthCommittedYen: 0,
      monthlyBudgetYen: 10000,
      pricing: { known: false, reason: 'pricing_unregistered' },
      retryFactor: 1,
    }).allowed,
    false,
  );
});

test('キットが禁じる遷移は、アプリ側でも誰にも許されない', () => {
  for (const from of POST_STATES) {
    for (const to of POST_STATES) {
      if (from === to) continue;
      let kitAllows = true;
      try {
        transition(from, to);
      } catch {
        kitAllows = false;
      }
      if (kitAllows) continue;
      // キットが禁じているなら、アプリ側も誰にも許してはいけない…
      // ただし意図的な追加は DIFFERENCES.md に記録した分だけ許す。
      const intentionalAdditions = new Set([
        'SCHEDULED->APPROVED', // 予約取消（承認は保持する）
        'FAILED->SCHEDULED',   // 管理者による再予約
        'EXPIRED->APPROVED',   // 内容そのままで再承認
        'UNKNOWN->PUBLISHED',  // 照合の結果（reconciler のみ）
        'UNKNOWN->FAILED',     // 照合の結果（reconciler のみ）
      ]);
      if (intentionalAdditions.has(`${from}->${to}`)) continue;
      assert.equal(
        forbiddenForEveryone(from, to), true,
        `キットは ${from} -> ${to} を禁じているのに、アプリ側で許されている`,
      );
    }
  }
});

test('危険な遷移は両方が禁じている', () => {
  const mustBeForbidden: [PostState, PostState][] = [
    ['DRAFT', 'PUBLISHING'],
    ['DRAFT', 'PUBLISHED'],
    ['APPROVED', 'PUBLISHING'],
    ['SCHEDULED', 'PUBLISHED'],
    ['UNKNOWN', 'SCHEDULED'],   // 結果不明からの再送
    ['UNKNOWN', 'CLAIMED'],
    ['UNKNOWN', 'PUBLISHING'],
    ['PUBLISHED', 'DRAFT'],     // 公開済みは終端
    ['PUBLISHED', 'SCHEDULED'],
  ];
  for (const [from, to] of mustBeForbidden) {
    assert.throws(() => transition(from, to), `キットが ${from} -> ${to} を許している`);
    assert.equal(forbiddenForEveryone(from, to), true, `アプリが ${from} -> ${to} を許している`);
  }
});

test('UNKNOWN から送信側へ戻す経路が、どちらにも無い', () => {
  // キット: UNKNOWN の次状態は空
  for (const to of POST_STATES) {
    assert.throws(() => transition('UNKNOWN', to));
  }
  // アプリ: 送信を担う担当は UNKNOWN から何もできない
  for (const to of POST_STATES) {
    assert.equal(canTransition('UNKNOWN', to, 'worker').ok, false, `worker が UNKNOWN -> ${to}`);
    assert.equal(canTransition('UNKNOWN', to, 'scheduler').ok, false, `scheduler が UNKNOWN -> ${to}`);
  }
});

test('送信可否の判断が一致する', () => {
  const nowMs = Date.UTC(2026, 3, 1, 12, 0, 0);
  const now = new Date(nowMs);
  const base = {
    platform: 'x' as const,
    body: '本文',
    scheduledAt: now,
    now,
    globalStop: false,
    platformStop: false,
    connectionMode: 'live' as const,
  };

  const cases = [
    { label: '停止中', enabled: false, published: [] as number[] },
    { label: '上限に到達', enabled: true, published: [nowMs - 100, nowMs - 200, nowMs - 300] },
    { label: '間隔が足りない', enabled: true, published: [nowMs - (POLICY.minIntervalMs - 1)] },
    { label: '間隔ちょうど', enabled: true, published: [nowMs - POLICY.minIntervalMs] },
    { label: '実績なし', enabled: true, published: [] },
  ];

  for (const c of cases) {
    const kit = scheduleDecision({
      nowMs, dueMs: nowMs, enabled: c.enabled, publishedAtMs: c.published,
    });
    const app = evaluateSendGate({
      ...base,
      globalStop: !c.enabled,
      recentPublishedAt: c.published.map((ms) => new Date(ms)),
    });
    assert.equal(app.allowed, kit.allowed, `${c.label}: kit=${kit.reason} app=${JSON.stringify(app)}`);
  }
});

test('期限切れの判断が一致する', () => {
  const nowMs = Date.UTC(2026, 3, 2, 12, 0, 0);
  const now = new Date(nowMs);
  const dueMs = nowMs - POLICY.scheduleGraceMs - 1;
  const kit = scheduleDecision({ nowMs, dueMs, enabled: true });
  const app = evaluateSendGate({
    platform: 'x', body: '本文', scheduledAt: new Date(dueMs), now,
    globalStop: false, platformStop: false, connectionMode: 'live',
  });
  assert.equal(kit.reason, 'EXPIRED');
  assert.equal(app.allowed === false && app.code, 'expired');
});

test('上限と間隔の値が一致する', () => {
  // キットの既定値（maxPer24h=3, minGapMs=7200000, expiryMs=86400000）と揃っているか
  assert.equal(POLICY.maxPostsPerPlatformPer24h, 3);
  assert.equal(POLICY.minIntervalMs, 7_200_000);
  assert.equal(POLICY.scheduleGraceMs, 86_400_000);
  assert.equal(POLICY.rateWindowMs, 86_400_000);
});
