import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRecords } from '../../src/domain/csv.ts';
import {
  parseSalesCsv, dedupeSales, summarizeSales, summarizeByChannel,
  isSalesChannel, CHANNEL_LABELS, SALES_CHANNELS,
} from '../../src/domain/sales-import.ts';

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

// ---------------------------------------------------------------- チャネル

test('取込時に指定したチャネルが全行に入る', () => {
  const rows = parseSalesCsv(csv, 'coconala');
  const ok = rows.filter((r) => r.ok);
  assert.ok(ok.length > 0);
  assert.equal(ok.every((r) => r.ok && r.value.channel === 'coconala'), true);
});

test('チャネルを省略すると note になる', () => {
  const rows = parseSalesCsv(csv);
  assert.equal(rows[0].ok && rows[0].value.channel, 'note');
});

test('チャネル名の検証', () => {
  assert.equal(isSalesChannel('note'), true);
  assert.equal(isSalesChannel('coconala'), true);
  assert.equal(isSalesChannel('mercari'), false);
  assert.equal(isSalesChannel(''), false);
  assert.equal(isSalesChannel(null), false);
  // 表示名はすべてのチャネルに用意されている
  for (const channel of SALES_CHANNELS) assert.ok(CHANNEL_LABELS[channel].length > 0);
});

test('チャネルごとに集計し、実績のあるものだけ返す', () => {
  const summary = summarizeByChannel([
    { channel: 'note', kind: 'SALE', grossYen: 9800, feeYen: 1470 },
    { channel: 'note', kind: 'SALE', grossYen: 1980, feeYen: 297 },
    { channel: 'coconala', kind: 'SALE', grossYen: 30000, feeYen: 6600 },
  ]);
  assert.equal(summary.length, 2, '実績のないチャネルは出さない');

  const note = summary.find((s) => s.channel === 'note')!;
  assert.equal(note.grossSalesYen, 11780);
  assert.equal(note.saleCount, 2);

  const coconala = summary.find((s) => s.channel === 'coconala')!;
  assert.equal(coconala.grossSalesYen, 30000);
  assert.equal(coconala.feesYen, 6600);
});

test('チャネルの手数料は互いに混ざらない', () => {
  const summary = summarizeByChannel([
    { channel: 'note', kind: 'SALE', grossYen: 9800, feeYen: 1470 },
    // ココナラ側だけ手数料が未入力
    { channel: 'coconala', kind: 'SALE', grossYen: 30000, feeYen: null },
  ]);
  const note = summary.find((s) => s.channel === 'note')!;
  const coconala = summary.find((s) => s.channel === 'coconala')!;
  assert.equal(note.feesYen, 1470, '片方の未入力が他方へ波及している');
  assert.equal(coconala.feesYen, null);
  assert.equal(coconala.missingFeeCount, 1);
});

test('返金もチャネルごとに分かれる', () => {
  const summary = summarizeByChannel([
    { channel: 'note', kind: 'SALE', grossYen: 9800, feeYen: 1470 },
    { channel: 'coconala', kind: 'REFUND', grossYen: 30000, feeYen: 6600 },
  ]);
  assert.equal(summary.find((s) => s.channel === 'note')!.refundsYen, 0);
  assert.equal(summary.find((s) => s.channel === 'coconala')!.refundsYen, 30000);
});

test('ココナラの列名（取引ID・販売金額など）を読める', () => {
  const coconalaCsv = [
    '取引ID,サービスID,販売金額,販売手数料,取引日,振込日,サービス名',
    'CC-1001,svc-01,"30,000",6600,2026/04/01,2026/04/30,LP制作',
    'CC-1002,svc-01,30000,6600,2026/04/05,,LP制作',
  ].join('\n');
  const rows = parseSalesCsv(coconalaCsv, 'coconala');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ok, true, rows[0].ok ? '' : JSON.stringify(rows[0]));
  assert.equal(rows[0].ok && rows[0].value.grossYen, 30000);
  assert.equal(rows[0].ok && rows[0].value.feeYen, 6600);
  assert.equal(rows[0].ok && rows[0].value.channel, 'coconala');
  assert.equal(rows[0].ok && rows[0].value.productCode, 'svc-01');
  assert.equal(rows[1].ok && rows[1].value.settledOn, null, '未入金は空のまま');
});

test('全期間のCSVを毎回取り込んでも増えない', () => {
  // ココナラの売上CSVは毎回「全期間・全件」が落ちてくる想定。
  const full = [
    '取引ID,サービスID,販売金額,販売手数料,取引日',
    'CC-1001,svc-01,30000,6600,2026/04/01',
    'CC-1002,svc-01,30000,6600,2026/04/05',
  ].join('\n');

  const first = dedupeSales(parseSalesCsv(full, 'coconala'), new Set());
  assert.equal(first.toInsert.length, 2);

  // 2回目: 既存2件 + 新規1件が含まれる全件ファイル
  const existing = new Set(first.toInsert.map((r) => r.externalOrderId));
  const grown = `${full}\nCC-1003,svc-02,50000,11000,2026/04/20`;
  const second = dedupeSales(parseSalesCsv(grown, 'coconala'), existing);

  assert.equal(second.toInsert.length, 1, '新規の1件だけが入る');
  assert.equal(second.toInsert[0].externalOrderId, 'CC-1003');
  assert.equal(second.duplicatesInDb.length, 2, '既存2件は除外される');
});
