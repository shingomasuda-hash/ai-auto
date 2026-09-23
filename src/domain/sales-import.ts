/**
 * 売上の手動入力 / CSV取込。
 *
 * - 注文IDで重複を防ぐ（一意制約はDB側でも張る）。
 * - 返金・販売手数料・入金日は売上とは別項目として区別する。
 * - 個別の購入を投稿に紐付けられるとは仮定しない。参照元は任意項目。
 */

import type { Yen } from './money.ts';
import { parseCsvRecords } from './csv.ts';

export const SALE_KINDS = ['SALE', 'REFUND'] as const;
export type SaleKind = (typeof SALE_KINDS)[number];

/**
 * 販売チャネル。
 *
 * note は教材の売り切り、coconala は役務提供で、事業の軸が別。
 * 集計は一つの画面で行うが、内訳は必ず分ける。
 */
export const SALES_CHANNELS = ['note', 'coconala', 'other'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const CHANNEL_LABELS: Readonly<Record<SalesChannel, string>> = {
  note: 'note',
  coconala: 'ココナラ',
  other: 'その他',
};

export function isSalesChannel(value: unknown): value is SalesChannel {
  return typeof value === 'string' && (SALES_CHANNELS as readonly string[]).includes(value);
}

export type SaleInput = {
  /** 販売元(note等)が発行する注文ID。所有者スコープで一意。 */
  externalOrderId: string;
  /** どのチャネルの売上か。取込時に指定する。 */
  channel: SalesChannel;
  kind: SaleKind;
  /** 商品コード（products.code）。 */
  productCode: string;
  /** 総額(円)。REFUND も正の数で入れ、符号は kind で判断する。 */
  grossYen: Yen;
  /** 販売手数料(円)。不明なら null。null のまま利益を確定表示しない。 */
  feeYen: Yen | null;
  /** 購入日時(UTC)。 */
  occurredAt: Date;
  /** 入金日(UTC)。未入金なら null。 */
  settledOn: Date | null;
  note: string | null;
};

export type ParsedRow =
  | { ok: true; line: number; value: SaleInput }
  | { ok: false; line: number; errors: string[]; raw: Record<string, string> };

/**
 * CSVの列名。販売元ごとに見出しが違うので別名を許す。
 *
 * ココナラは「売上管理・振込申請」から全期間の売上CSVを落とせる。
 * 毎回全件が落ちてくるので、注文IDでの重複排除が効く前提の設計。
 * 実際の見出しが合わない場合はここへ追記する。
 */
export const CSV_COLUMNS = {
  externalOrderId: ['order_id', '注文ID', '注文番号', '取引ID', '取引番号'],
  kind: ['kind', '区分'],
  productCode: ['product_code', '商品コード', 'サービスID'],
  grossYen: ['gross_yen', '金額', '売上', '販売金額', '売上金額'],
  feeYen: ['fee_yen', '手数料', '販売手数料', 'システム利用料'],
  occurredAt: ['occurred_at', '購入日時', '日時', '購入日', '取引日', '売上日'],
  settledOn: ['settled_on', '入金日', '振込日'],
  note: ['note', '備考', 'サービス名', 'メモ'],
} as const;

function pick(record: Record<string, string>, candidates: readonly string[]): string | undefined {
  for (const key of candidates) {
    if (key in record && record[key] !== '') return record[key];
  }
  return undefined;
}

function parseIntegerYen(raw: string | undefined, label: string, errors: string[]): Yen | null {
  if (raw === undefined || raw === '') return null;
  const cleaned = raw.replace(/[¥￥,\s]/g, '');
  if (!/^-?\d+$/.test(cleaned)) {
    errors.push(`${label}は整数の円で入力してください: ${raw}`);
    return null;
  }
  return Number(cleaned);
}

function parseDate(raw: string | undefined, label: string, errors: string[], required: boolean): Date | null {
  if (raw === undefined || raw === '') {
    if (required) errors.push(`${label}は必須です。`);
    return null;
  }
  // 日付のみなら JST 0時として解釈する。
  const dateOnly = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(raw);
  const iso = dateOnly ? `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00+09:00` : raw;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    errors.push(`${label}を日時として解釈できません: ${raw}`);
    return null;
  }
  return parsed;
}

export function parseSalesCsv(csv: string, channel: SalesChannel = 'note'): ParsedRow[] {
  const { records } = parseCsvRecords(csv);
  return records.map((record, index) => {
    const line = index + 2; // ヘッダ行を1行目とする
    const errors: string[] = [];

    const externalOrderId = pick(record, CSV_COLUMNS.externalOrderId)?.trim() ?? '';
    if (externalOrderId === '') errors.push('注文IDは必須です。');

    const kindRaw = (pick(record, CSV_COLUMNS.kind) ?? 'SALE').toUpperCase();
    const kind = kindRaw === '返金' ? 'REFUND' : kindRaw;
    if (!(SALE_KINDS as readonly string[]).includes(kind)) {
      errors.push(`区分は SALE か REFUND で入力してください: ${kindRaw}`);
    }

    const productCode = pick(record, CSV_COLUMNS.productCode)?.trim() ?? '';
    if (productCode === '') errors.push('商品コードは必須です。');

    const grossYen = parseIntegerYen(pick(record, CSV_COLUMNS.grossYen), '金額', errors);
    if (grossYen === null && !errors.some((e) => e.startsWith('金額'))) errors.push('金額は必須です。');
    if (grossYen !== null && grossYen < 0) errors.push('金額は正の数で入力してください（返金は区分で表します）。');

    const feeYen = parseIntegerYen(pick(record, CSV_COLUMNS.feeYen), '手数料', errors);
    const occurredAt = parseDate(pick(record, CSV_COLUMNS.occurredAt), '購入日時', errors, true);
    const settledOn = parseDate(pick(record, CSV_COLUMNS.settledOn), '入金日', errors, false);

    if (errors.length > 0 || grossYen === null || occurredAt === null) {
      return { ok: false, line, errors, raw: record };
    }

    return {
      ok: true,
      line,
      value: {
        externalOrderId,
        channel,
        kind: kind as SaleKind,
        productCode,
        grossYen,
        feeYen,
        occurredAt,
        settledOn,
        note: pick(record, CSV_COLUMNS.note) ?? null,
      },
    };
  });
}

export type DedupeResult = {
  toInsert: SaleInput[];
  duplicatesInFile: { line: number; externalOrderId: string }[];
  duplicatesInDb: { line: number; externalOrderId: string }[];
  invalid: { line: number; errors: string[] }[];
};

/**
 * 取込対象を振り分ける。
 * 同一ファイル内の重複と、既存DBとの重複を分けて報告する。
 */
export function dedupeSales(rows: readonly ParsedRow[], existingOrderIds: ReadonlySet<string>): DedupeResult {
  const result: DedupeResult = { toInsert: [], duplicatesInFile: [], duplicatesInDb: [], invalid: [] };
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.ok) {
      result.invalid.push({ line: row.line, errors: row.errors });
      continue;
    }
    const id = row.value.externalOrderId;
    if (seen.has(id)) {
      result.duplicatesInFile.push({ line: row.line, externalOrderId: id });
      continue;
    }
    if (existingOrderIds.has(id)) {
      result.duplicatesInDb.push({ line: row.line, externalOrderId: id });
      continue;
    }
    seen.add(id);
    result.toInsert.push(row.value);
  }

  return result;
}

export type SalesSummary = {
  grossSalesYen: Yen;
  refundsYen: Yen;
  /** 手数料の合計。1件でも未入力があれば null。 */
  feesYen: Yen | null;
  /** 手数料が未入力の件数。 */
  missingFeeCount: number;
  saleCount: number;
  refundCount: number;
};

export type ChannelSummary = SalesSummary & { channel: SalesChannel };

/**
 * チャネルごとに集計する。実績のあるチャネルだけを返す。
 * 手数料が1件でも未入力なら、そのチャネルの合計は確定しない。
 */
export function summarizeByChannel(
  sales: readonly Pick<SaleInput, 'channel' | 'kind' | 'grossYen' | 'feeYen'>[],
): ChannelSummary[] {
  const byChannel = new Map<SalesChannel, Pick<SaleInput, 'kind' | 'grossYen' | 'feeYen'>[]>();
  for (const sale of sales) {
    const list = byChannel.get(sale.channel) ?? [];
    list.push(sale);
    byChannel.set(sale.channel, list);
  }
  return SALES_CHANNELS
    .filter((channel) => byChannel.has(channel))
    .map((channel) => ({ channel, ...summarizeSales(byChannel.get(channel)!) }));
}

export function summarizeSales(sales: readonly Pick<SaleInput, 'kind' | 'grossYen' | 'feeYen'>[]): SalesSummary {
  let grossSalesYen = 0;
  let refundsYen = 0;
  let feesYen = 0;
  let missingFeeCount = 0;
  let saleCount = 0;
  let refundCount = 0;

  for (const sale of sales) {
    if (sale.kind === 'SALE') {
      grossSalesYen += sale.grossYen;
      saleCount += 1;
    } else {
      refundsYen += sale.grossYen;
      refundCount += 1;
    }
    if (sale.feeYen === null) missingFeeCount += 1;
    else feesYen += sale.kind === 'SALE' ? sale.feeYen : -sale.feeYen;
  }

  return {
    grossSalesYen,
    refundsYen,
    feesYen: missingFeeCount > 0 ? null : feesYen,
    missingFeeCount,
    saleCount,
    refundCount,
  };
}
