/**
 * チャネル別の管理を検証する。
 *
 * note（教材の売り切り）と ココナラ（役務提供）は事業の軸が別。
 * 集計は一つの画面で行うが、数字と導線は混ざってはいけない。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { insertSales, importSalesCsv, summarizeMonth } from '../../src/db/sales.ts';
import { upsertProduct, listProducts } from '../../src/db/products.ts';
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
});

const sale = (id: string, channel: 'note' | 'coconala' | 'other', grossYen: number, feeYen: number | null) => ({
  externalOrderId: id,
  channel,
  kind: 'SALE' as const,
  productCode: channel === 'note' ? 'starter' : 'lp-seisaku',
  grossYen,
  feeYen,
  occurredAt: now,
  settledOn: null,
  note: null,
});

test('既存の売上はチャネル未指定なら note になる', options, async () => {
  await insertSales(ownerId, [sale('N-1', 'note', 1980, 297)], 'manual');
  const rows = await query<{ channel: string }>(`SELECT channel FROM sales`);
  assert.equal(rows[0].channel, 'note');
});

test('チャネルが違えば内訳が分かれ、合計は一つにまとまる', options, async () => {
  await insertSales(ownerId, [
    sale('N-1', 'note', 9800, 1470),
    sale('N-2', 'note', 1980, 297),
    sale('C-1', 'coconala', 30000, 6600),
  ], 'manual');

  const { summary, byChannel } = await summarizeMonth(ownerId, monthKey);

  // 合計は一つ（管理は一緒）
  assert.equal(summary.grossSalesYen, 41780);
  assert.equal(summary.saleCount, 3);

  // 内訳は分かれる（軸は別）
  assert.equal(byChannel.length, 2);
  assert.equal(byChannel.find((c) => c.channel === 'note')!.grossSalesYen, 11780);
  assert.equal(byChannel.find((c) => c.channel === 'coconala')!.grossSalesYen, 30000);
});

test('片方のチャネルの手数料未入力が、もう片方へ波及しない', options, async () => {
  await insertSales(ownerId, [
    sale('N-1', 'note', 9800, 1470),
    sale('C-1', 'coconala', 30000, null),
  ], 'manual');

  const { summary, byChannel } = await summarizeMonth(ownerId, monthKey);
  // 全体としては未確定
  assert.equal(summary.feesYen, null);
  // note 単体では確定している
  assert.equal(byChannel.find((c) => c.channel === 'note')!.feesYen, 1470);
  assert.equal(byChannel.find((c) => c.channel === 'coconala')!.feesYen, null);
});

test('ココナラのCSVをチャネル指定で取り込める', options, async () => {
  const csv = [
    '取引ID,サービスID,販売金額,販売手数料,取引日',
    'CC-1001,lp-seisaku,30000,6600,2026-04-01',
    'CC-1002,lp-seisaku,50000,11000,2026-04-05',
  ].join('\n');

  const result = await importSalesCsv(ownerId, csv, 'coconala');
  assert.equal(result.insertedCount, 2);

  const rows = await query<{ channel: string; gross_yen: number }>(
    `SELECT channel, gross_yen FROM sales ORDER BY gross_yen`,
  );
  assert.equal(rows.every((r) => r.channel === 'coconala'), true);
  assert.deepEqual(rows.map((r) => r.gross_yen), [30000, 50000]);
});

test('全期間のCSVを繰り返し取り込んでも二重計上しない', options, async () => {
  const first = ['取引ID,サービスID,販売金額,販売手数料,取引日',
    'CC-1001,lp-seisaku,30000,6600,2026-04-01'].join('\n');
  await importSalesCsv(ownerId, first, 'coconala');

  // 翌月、全期間ぶんが落ちてくる（既存1件 + 新規1件）
  const second = `${first}\nCC-1002,lp-seisaku,50000,11000,2026-05-10`;
  const result = await importSalesCsv(ownerId, second, 'coconala');

  assert.equal(result.insertedCount, 1, '新規の1件だけが入る');
  const rows = await query(`SELECT 1 FROM sales`);
  assert.equal(rows.length, 2);
});

test('商品はチャネルと種別を持ち、役務と売り切りを区別できる', options, async () => {
  await upsertProduct(ownerId, {
    code: 'starter', name: 'Starter', priceYen: 1980, noteUrl: null,
    composition: [], isPublished: false,
  });
  await upsertProduct(ownerId, {
    code: 'lp-seisaku', name: 'LP制作', priceYen: 30000, noteUrl: 'https://coconala.com/services/x',
    composition: [], isPublished: true, channel: 'coconala', kind: 'service',
  });

  const products = await listProducts(ownerId);
  const starter = products.find((p) => p.code === 'starter')!;
  const service = products.find((p) => p.code === 'lp-seisaku')!;

  assert.equal(starter.channel, 'note', '既定は note');
  assert.equal(starter.kind, 'digital_product');
  assert.equal(service.channel, 'coconala');
  assert.equal(service.kind, 'service');
});

test('投稿のCTAに使えるのは note の商品だけ', options, async () => {
  await upsertProduct(ownerId, {
    code: 'starter', name: 'Starter', priceYen: 1980,
    noteUrl: 'https://note.com/x/n/starter', composition: [], isPublished: true,
  });
  await upsertProduct(ownerId, {
    code: 'lp-seisaku', name: 'LP制作', priceYen: 30000,
    noteUrl: 'https://coconala.com/services/x', composition: [], isPublished: true,
    channel: 'coconala', kind: 'service',
  });

  // generate.ts が参照するのと同じ条件
  const allowed = await query<{ note_url: string }>(
    `SELECT note_url FROM products
      WHERE owner_id = $1 AND note_url IS NOT NULL AND channel = 'note'`,
    [ownerId],
  );
  assert.deepEqual(allowed.map((r) => r.note_url), ['https://note.com/x/n/starter']);
  assert.equal(
    allowed.some((r) => r.note_url.includes('coconala')), false,
    'ココナラのURLが投稿の導線に混ざっている',
  );
});

test('不正なチャネルはDBが拒否する', options, async () => {
  await assert.rejects(
    () => query(
      `INSERT INTO sales (owner_id, external_order_id, channel, kind, product_code, gross_yen, occurred_at)
       VALUES ($1, 'X-1', 'mercari', 'SALE', 'p', 100, now())`,
      [ownerId],
    ),
    /sales_channel_check/,
  );
});

test('注文IDの一意制約はチャネルをまたいで効く', options, async () => {
  await insertSales(ownerId, [sale('SAME-ID', 'note', 1000, 0)], 'manual');
  const { inserted, skipped } = await insertSales(
    ownerId, [sale('SAME-ID', 'coconala', 9999, 0)], 'manual',
  );
  assert.equal(inserted.length, 0, '別チャネルでも同じ注文IDは二重に入らない');
  assert.deepEqual(skipped, ['SAME-ID']);
});
