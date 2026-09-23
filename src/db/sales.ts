import { query, withTransaction } from './pool.ts';
import { recordAudit } from './audit.ts';
import type { SaleInput, DedupeResult, SalesChannel } from '../domain/sales-import.ts';
import { dedupeSales, parseSalesCsv, summarizeSales, summarizeByChannel } from '../domain/sales-import.ts';
import { jstMonthRange } from '../domain/time.ts';

export type SaleRow = {
  id: string;
  owner_id: string;
  external_order_id: string;
  channel: SalesChannel;
  kind: 'SALE' | 'REFUND';
  product_code: string;
  gross_yen: number;
  fee_yen: number | null;
  occurred_at: Date;
  settled_on: Date | null;
  note: string | null;
  source: 'manual' | 'csv';
};

export async function listSales(ownerId: string, limit = 200): Promise<SaleRow[]> {
  return query<SaleRow>(
    `SELECT * FROM sales WHERE owner_id = $1 ORDER BY occurred_at DESC, created_at DESC LIMIT $2`,
    [ownerId, limit],
  );
}

export async function listSalesInMonth(ownerId: string, monthKey: string): Promise<SaleRow[]> {
  const { startUtc, endUtcExclusive } = jstMonthRange(monthKey);
  return query<SaleRow>(
    `SELECT * FROM sales
      WHERE owner_id = $1 AND occurred_at >= $2 AND occurred_at < $3
      ORDER BY occurred_at DESC`,
    [ownerId, startUtc, endUtcExclusive],
  );
}

export type InsertSalesResult = DedupeResult & { insertedCount: number };

/** 注文IDで重複を弾いて取り込む。DB側の一意制約でも二重登録を防ぐ。 */
export async function insertSales(
  ownerId: string,
  sales: readonly SaleInput[],
  source: 'manual' | 'csv',
): Promise<{ inserted: SaleRow[]; skipped: string[] }> {
  return withTransaction(async (client) => {
    const inserted: SaleRow[] = [];
    const skipped: string[] = [];
    for (const sale of sales) {
      const { rows } = await client.query<SaleRow>(
        `INSERT INTO sales
           (owner_id, external_order_id, channel, kind, product_code, gross_yen, fee_yen,
            occurred_at, settled_on, note, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (owner_id, external_order_id) DO NOTHING
         RETURNING *`,
        [
          ownerId, sale.externalOrderId, sale.channel, sale.kind, sale.productCode, sale.grossYen,
          sale.feeYen, sale.occurredAt, sale.settledOn, sale.note, source,
        ],
      );
      if (rows[0]) inserted.push(rows[0]);
      else skipped.push(sale.externalOrderId);
    }
    await recordAudit(
      {
        ownerId, actor: 'owner', action: 'sales.import',
        detail: { source, insertedCount: inserted.length, skippedCount: skipped.length },
      },
      client,
    );
    return { inserted, skipped };
  });
}

/**
 * CSVを取り込む。
 *
 * ココナラの売上CSVは毎回「全期間・全件」が落ちてくる。
 * 注文IDの一意制約で既存分は弾かれるので、同じファイルを何度
 * 取り込んでも増えない。これが取込の前提。
 */
export async function importSalesCsv(
  ownerId: string,
  csv: string,
  channel: SalesChannel = 'note',
): Promise<InsertSalesResult> {
  const rows = parseSalesCsv(csv, channel);
  const existing = new Set(
    (await query<{ external_order_id: string }>(
      `SELECT external_order_id FROM sales WHERE owner_id = $1`, [ownerId],
    )).map((r) => r.external_order_id),
  );
  const result = dedupeSales(rows, existing);
  const { inserted, skipped } = await insertSales(ownerId, result.toInsert, 'csv');
  // 競合で弾かれた分は既存重複として報告する。
  for (const orderId of skipped) {
    result.duplicatesInDb.push({ line: 0, externalOrderId: orderId });
  }
  return { ...result, insertedCount: inserted.length };
}

export async function summarizeMonth(ownerId: string, monthKey: string) {
  const sales = await listSalesInMonth(ownerId, monthKey);
  const rows = sales.map((s) => ({
    channel: s.channel, kind: s.kind, grossYen: s.gross_yen, feeYen: s.fee_yen,
  }));
  return {
    sales,
    summary: summarizeSales(rows),
    // 事業の軸が別なので、合計とは別に内訳も出す。
    byChannel: summarizeByChannel(rows),
  };
}

export async function sumExpenses(ownerId: string, monthKey: string): Promise<number> {
  const { startUtc, endUtcExclusive } = jstMonthRange(monthKey);
  const rows = await query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_yen), 0)::text AS total
       FROM expense_entries
      WHERE owner_id = $1 AND incurred_on >= $2 AND incurred_on < $3`,
    [ownerId, startUtc, endUtcExclusive],
  );
  return Number(rows[0].total);
}

export async function addExpense(
  ownerId: string,
  input: { category: 'ai' | 'x_api' | 'infra' | 'reserve'; amountYen: number; incurredOn: Date; memo: string; isFixed: boolean },
): Promise<void> {
  await query(
    `INSERT INTO expense_entries (owner_id, category, amount_yen, incurred_on, memo, is_fixed)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ownerId, input.category, input.amountYen, input.incurredOn, input.memo, input.isFixed],
  );
}
