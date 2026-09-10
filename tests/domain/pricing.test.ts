import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPricingTable, estimateYen, actualYen, roughTokenCount } from '../../src/ai/pricing.ts';
import { extractJson } from '../../src/ai/generate.ts';

test('料金が未登録なら未登録として扱う', () => {
  assert.deepEqual(loadPricingTable({}), { registered: false, reason: 'pricing_unregistered' });
  assert.deepEqual(
    loadPricingTable({ AI_PRICE_INPUT_PER_MTOK: '3' }),
    { registered: false, reason: 'pricing_unregistered' },
  );
});

test('外貨建てで為替が未登録なら止める', () => {
  const table = loadPricingTable({
    AI_PRICE_INPUT_PER_MTOK: '3', AI_PRICE_OUTPUT_PER_MTOK: '15', AI_PRICE_CURRENCY: 'USD',
  });
  assert.deepEqual(table, { registered: false, reason: 'fx_rate_unregistered' });
});

test('円建てなら為替なしで登録できる', () => {
  const table = loadPricingTable({
    AI_PRICE_INPUT_PER_MTOK: '450', AI_PRICE_OUTPUT_PER_MTOK: '2250', AI_PRICE_CURRENCY: 'JPY',
  });
  assert.equal(table.registered, true);
  assert.equal(table.registered && table.fxRateToJpy, 1);
});

test('見込額は切り上げで計算する', () => {
  const table = loadPricingTable({
    AI_PRICE_INPUT_PER_MTOK: '3', AI_PRICE_OUTPUT_PER_MTOK: '15',
    AI_PRICE_CURRENCY: 'USD', AI_FX_RATE_TO_JPY: '150',
  });
  const status = estimateYen({ inputTokens: 1_000_000, maxOutputTokens: 1_000_000 }, table);
  assert.equal(status.known, true);
  assert.equal(status.known && status.estimateYen, 3 * 150 + 15 * 150);

  const small = estimateYen({ inputTokens: 1000, maxOutputTokens: 1000 }, table);
  // 端数は切り上げる（0円にしない）
  assert.equal(small.known && small.estimateYen, 3);
});

test('未登録の料金表では見込額を返さない', () => {
  const status = estimateYen({ inputTokens: 100, maxOutputTokens: 100 }, { registered: false, reason: 'pricing_unregistered' });
  assert.equal(status.known, false);
  assert.equal(status.known === false && status.reason, 'pricing_unregistered');
});

test('実績額も同じ表で計算する', () => {
  const table = loadPricingTable({
    AI_PRICE_INPUT_PER_MTOK: '3', AI_PRICE_OUTPUT_PER_MTOK: '15',
    AI_PRICE_CURRENCY: 'USD', AI_FX_RATE_TO_JPY: '150',
  });
  assert.equal(actualYen({ inputTokens: 1_000_000, outputTokens: 0 }, table), 450);
  assert.equal(actualYen({ inputTokens: 0, outputTokens: 0 }, { registered: false, reason: 'pricing_unregistered' }), null);
});

test('トークン数は安全側(多め)に見積もる', () => {
  assert.ok(roughTokenCount('あいうえお') > 5);
  assert.ok(roughTokenCount('') > 0);
});

test('前後に説明が付いてもJSONを取り出す', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson('説明\n```json\n{"a":1}\n```\nおわり'), '{"a":1}');
  assert.equal(extractJson('はい、こちらです。{"a":1} 以上です。'), '{"a":1}');
});
