import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProfit, feeFromBasisPoints, goalGap, sumYen, assertYen, formatYen } from '../../src/domain/money.ts';

test('整数の円しか受け付けない', () => {
  assert.equal(assertYen(100), 100);
  assert.throws(() => assertYen(1.5), TypeError);
  assert.throws(() => assertYen('100' as unknown), TypeError);
});

test('sumYen は合計する', () => {
  assert.equal(sumYen([1980, 9800]), 11780);
  assert.equal(sumYen([]), 0);
});

test('手数料は基準点から切り捨てで計算する', () => {
  assert.equal(feeFromBasisPoints(1980, 1500), 297);
  assert.equal(feeFromBasisPoints(999, 1500), 149); // 149.85 -> 149
  assert.throws(() => feeFromBasisPoints(100, 10001), RangeError);
});

test('手数料が未入力なら利益を確定しない', () => {
  const result = computeProfit({
    grossSalesYen: 19800,
    refundsYen: 0,
    platformFeesYen: null,
    operatingCostsYen: 3000,
  });
  assert.equal(result.netSalesYen, 19800);
  assert.equal(result.pretaxProfitYen, null);
  assert.deepEqual(result.unresolved, ['platform_fees_missing']);
  assert.equal(goalGap(result.pretaxProfitYen, 300000), null);
});

test('手数料が入力されていれば税引前収支を出す', () => {
  const result = computeProfit({
    grossSalesYen: 19800,
    refundsYen: 1980,
    platformFeesYen: 2673,
    operatingCostsYen: 3000,
  });
  assert.equal(result.netSalesYen, 17820);
  assert.equal(result.pretaxProfitYen, 17820 - 2673 - 3000);
  assert.deepEqual(result.unresolved, []);
  assert.equal(goalGap(result.pretaxProfitYen, 300000), 12147 - 300000);
});

test('売上0件でも計算できる', () => {
  const result = computeProfit({ grossSalesYen: 0, refundsYen: 0, platformFeesYen: 0, operatingCostsYen: 0 });
  assert.equal(result.pretaxProfitYen, 0);
});

test('確定できない値は — で表示する', () => {
  assert.equal(formatYen(null), '—');
  assert.equal(formatYen(-1980), '-¥1,980');
});
