import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRecords } from '../../src/domain/csv.ts';
import { parseSalesCsv, dedupeSales, summarizeSales } from '../../src/domain/sales-import.ts';

test('CSVは引用符内のカンマ・改行・二重引用符を扱う', () => {
  const rows = parseCsv('a,b\n"1,2","改行\nあり"\n"""引用""",x');
  assert.deepEqual(rows, [['a', 'b'], ['1,2', '改行\nあり'], ['"引用"', 'x']]);
});

test('CSVはBOMと空行を無視する', () => {
  const { headers, records } = parseCsvRecords('﻿order_id,金額\n\nA1,1980\n');
  assert.deepEqual(headers, ['order_id', '金額']);
  assert.equal(records.length, 1);
  assert.equal(records[0].order_id, 'A1');
});

const csv = [
  'order_id,kind,product_code,gross_yen,fee_yen,occurred_at,settled_on,note',
  'ORD-1,SALE,starter,1980,297,2026-04-01,2026-04-25,初回',
  'ORD-2,SALE,bundle10,"9,800",,2026-04-02T10:00:00+09:00,,手数料未確定',
  'ORD-1,SALE,starter,1980,297,2026-04-01,,重複',
  'ORD-3,REFUND,starter,1980,297,2026-04-05,,返金',
  'ORD-4,SALE,starter,abc,,2026-04-06,,金額不正',
  ',SALE,starter,1980,,2026-04-07,,注文ID欠落',
].join('\n');

test('CSVの各行を検証して読み込む', () => {
  const rows = parseSalesCsv(csv);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].ok && rows[0].value.grossYen, 1980);
  assert.equal(rows[0].ok && rows[0].value.feeYen, 297);
  assert.equal(rows[0].ok && rows[0].value.settledOn?.toISOString(), '2026-04-24T15:00:00.000Z');
  // 日付のみはJST 0時として解釈する
  assert.equal(rows[0].ok && rows[0].value.occurredAt.toISOString(), '2026-03-31T15:00:00.000Z');
});

test('カンマ区切りの金額と手数料未入力を扱う', () => {
  const rows = parseSalesCsv(csv);
  assert.equal(rows[1].ok && rows[1].value.grossYen, 9800);
  assert.equal(rows[1].ok && rows[1].value.feeYen, null);
  assert.equal(rows[1].ok && rows[1].value.settledOn, null);
});

test('不正な行はエラー行として分離する', () => {
  const rows = parseSalesCsv(csv);
  assert.equal(rows[4].ok, false);
  assert.equal(rows[4].ok === false && rows[4].line, 6);
  assert.equal(rows[5].ok, false);
  assert.equal(rows[5].ok === false && rows[5].errors.some((e) => e.includes('注文ID')), true);
});

test('注文IDでファイル内・DB既存の重複を分けて弾く', () => {
  const rows = parseSalesCsv(csv);
  const result = dedupeSales(rows, new Set(['ORD-3']));
  assert.deepEqual(result.toInsert.map((r) => r.externalOrderId), ['ORD-1', 'ORD-2']);
  assert.deepEqual(result.duplicatesInFile, [{ line: 4, externalOrderId: 'ORD-1' }]);
  assert.deepEqual(result.duplicatesInDb, [{ line: 5, externalOrderId: 'ORD-3' }]);
  assert.equal(result.invalid.length, 2);
});

test('同じCSVを二度取り込んでも増えない', () => {
  const rows = parseSalesCsv(csv);
  const first = dedupeSales(rows, new Set());
  const existing = new Set(first.toInsert.map((r) => r.externalOrderId));
  const second = dedupeSales(rows, existing);
  assert.equal(second.toInsert.length, 0);
});

test('返金と手数料を売上と区別して集計する', () => {
  const summary = summarizeSales([
    { kind: 'SALE', grossYen: 1980, feeYen: 297 },
    { kind: 'SALE', grossYen: 9800, feeYen: 1470 },
    { kind: 'REFUND', grossYen: 1980, feeYen: 297 },
  ]);
  assert.equal(summary.grossSalesYen, 11780);
  assert.equal(summary.refundsYen, 1980);
  assert.equal(summary.feesYen, 297 + 1470 - 297);
  assert.equal(summary.saleCount, 2);
  assert.equal(summary.refundCount, 1);
});

test('手数料が1件でも未入力なら合計を確定しない', () => {
  const summary = summarizeSales([
    { kind: 'SALE', grossYen: 1980, feeYen: 297 },
    { kind: 'SALE', grossYen: 9800, feeYen: null },
  ]);
  assert.equal(summary.feesYen, null);
  assert.equal(summary.missingFeeCount, 1);
});

test('0件でも集計できる', () => {
  const summary = summarizeSales([]);
  assert.equal(summary.grossSalesYen, 0);
  assert.equal(summary.feesYen, 0);
});
