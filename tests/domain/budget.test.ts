import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MONTHLY_BUDGET_YEN, DEFAULT_ENVELOPES, WARN_RATIO,
  viewEnvelope, decideReservation, settle,
} from '../../src/domain/budget.ts';
import type { EnvelopeState } from '../../src/domain/budget.ts';

const envelope = (over: Partial<EnvelopeState> = {}): EnvelopeState => ({
  category: 'ai',
  limitYen: 3000,
  settledYen: 0,
  reservedYen: 0,
  fixedYen: 0,
  ...over,
});

test('予算の内訳は合計10,000円', () => {
  const total = Object.values(DEFAULT_ENVELOPES).reduce((a, b) => a + b, 0);
  assert.equal(total, DEFAULT_MONTHLY_BUDGET_YEN);
});

test('固定費は先に差し引く', () => {
  const view = viewEnvelope(envelope({ fixedYen: 2000, settledYen: 300 }));
  assert.equal(view.committedYen, 2300);
  assert.equal(view.availableYen, 700);
});

test('80%で警告する', () => {
  assert.equal(viewEnvelope(envelope({ settledYen: 2399 })).warn, false);
  assert.equal(viewEnvelope(envelope({ settledYen: 2400 })).warn, true);
  assert.equal(WARN_RATIO, 0.8);
});

test('料金や為替が未登録なら有料処理を止める', () => {
  for (const reason of ['pricing_unregistered', 'fx_rate_unregistered', 'estimate_unavailable'] as const) {
    const decision = decideReservation({
      envelope: envelope(),
      monthCommittedYen: 0,
      monthlyBudgetYen: DEFAULT_MONTHLY_BUDGET_YEN,
      pricing: { known: false, reason },
      retryFactor: 1,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, 'pricing_unknown');
  }
});

test('見込額にはSDKの暗黙リトライ分を含める', () => {
  const decision = decideReservation({
    envelope: envelope(),
    monthCommittedYen: 0,
    monthlyBudgetYen: DEFAULT_MONTHLY_BUDGET_YEN,
    pricing: { known: true, estimateYen: 100 },
    retryFactor: 3,
  });
  assert.equal(decision.allowed && decision.reserveYen, 300);
});

test('使用済+予約済+新規見込が枠を超えるなら拒否する', () => {
  const decision = decideReservation({
    envelope: envelope({ settledYen: 2000, reservedYen: 900 }),
    monthCommittedYen: 2900,
    monthlyBudgetYen: DEFAULT_MONTHLY_BUDGET_YEN,
    pricing: { known: true, estimateYen: 101 },
    retryFactor: 1,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.code, 'envelope_exceeded');
  assert.equal(decision.allowed === false && decision.code === 'envelope_exceeded' && decision.availableYen, 100);
});

test('枠に余裕があっても月次総額を超えるなら拒否する', () => {
  const decision = decideReservation({
    envelope: envelope({ limitYen: 3000 }),
    monthCommittedYen: 9950,
    monthlyBudgetYen: DEFAULT_MONTHLY_BUDGET_YEN,
    pricing: { known: true, estimateYen: 100 },
    retryFactor: 1,
  });
  assert.equal(decision.allowed === false && decision.code, 'total_exceeded');
});

test('ちょうど残高ぶんは通る', () => {
  const decision = decideReservation({
    envelope: envelope({ settledYen: 2900 }),
    monthCommittedYen: 2900,
    monthlyBudgetYen: DEFAULT_MONTHLY_BUDGET_YEN,
    pricing: { known: true, estimateYen: 100 },
    retryFactor: 1,
  });
  assert.equal(decision.allowed, true);
});

test('成功時は実績で精算し、余りを解放する', () => {
  const result = settle({ reservedYen: 300, outcome: { kind: 'success', actualYen: 120 } });
  assert.equal(result.state, 'SETTLED');
  assert.equal(result.settledYen, 120);
  assert.equal(result.releasedYen, 180);
  assert.equal(result.heldYen, 0);
});

test('実績が見込を超えても実績を計上し、警告を残す', () => {
  const result = settle({ reservedYen: 100, outcome: { kind: 'success', actualYen: 150 } });
  assert.equal(result.settledYen, 150);
  assert.equal(result.releasedYen, 0);
  assert.match(result.note, /超過/);
});

test('課金なしが確実な失敗だけ予約を解放する', () => {
  const result = settle({ reservedYen: 300, outcome: { kind: 'failed_not_charged' } });
  assert.equal(result.state, 'RELEASED');
  assert.equal(result.releasedYen, 300);
});

test('課金有無が不明な失敗では予約を解放しない', () => {
  const result = settle({ reservedYen: 300, outcome: { kind: 'failed_unknown' } });
  assert.equal(result.state, 'UNSETTLED');
  assert.equal(result.releasedYen, 0);
  assert.equal(result.heldYen, 300);
  assert.equal(result.settledYen, 0);
});

test('retryFactor が1未満なら例外', () => {
  assert.throws(() => decideReservation({
    envelope: envelope(),
    monthCommittedYen: 0,
    monthlyBudgetYen: DEFAULT_MONTHLY_BUDGET_YEN,
    pricing: { known: true, estimateYen: 10 },
    retryFactor: 0.5,
  }), RangeError);
});
