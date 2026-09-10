/**
 * 金額はすべて「整数の円」で扱う。浮動小数点は使わない。
 * 端数処理が必要な場合（手数料率など）は呼び出し側で丸め方法を明示する。
 */

export type Yen = number;

export function assertYen(value: unknown, label = 'amount'): Yen {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of yen`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} is out of safe integer range`);
  }
  return value;
}

export function sumYen(values: readonly Yen[]): Yen {
  let total = 0;
  for (const v of values) total += assertYen(v);
  return total;
}

/** 手数料率(基準点=1/10000)から手数料を計算する。丸めは切り捨て。 */
export function feeFromBasisPoints(gross: Yen, basisPoints: number): Yen {
  assertYen(gross, 'gross');
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new RangeError('basisPoints must be an integer between 0 and 10000');
  }
  return Math.floor((gross * basisPoints) / 10000);
}

export type ProfitInput = {
  /** 実売上（返金を除いた確定分）。 */
  grossSalesYen: Yen;
  /** 返金額の合計。正の数で渡す。 */
  refundsYen: Yen;
  /**
   * 販売手数料の合計。未入力（不明）の場合は null。
   * null のときは税引前収支を確定値として表示してはならない。
   */
  platformFeesYen: Yen | null;
  /** 運営実費（AI/API/ホスティング等）の合計。 */
  operatingCostsYen: Yen;
};

export type ProfitResult = {
  netSalesYen: Yen;
  /** 税引前収支。手数料が未入力なら null。 */
  pretaxProfitYen: Yen | null;
  /** 手数料未入力などで確定できない理由。確定できる場合は空配列。 */
  unresolved: string[];
};

/**
 * 税引前収支を計算する。
 * 販売手数料が未入力のときは利益を「確定値」として返さない（null）。
 */
export function computeProfit(input: ProfitInput): ProfitResult {
  assertYen(input.grossSalesYen, 'grossSalesYen');
  assertYen(input.refundsYen, 'refundsYen');
  assertYen(input.operatingCostsYen, 'operatingCostsYen');
  if (input.refundsYen < 0) throw new RangeError('refundsYen must be >= 0');

  const netSalesYen = input.grossSalesYen - input.refundsYen;
  const unresolved: string[] = [];

  if (input.platformFeesYen === null) {
    unresolved.push('platform_fees_missing');
    return { netSalesYen, pretaxProfitYen: null, unresolved };
  }

  assertYen(input.platformFeesYen, 'platformFeesYen');
  const pretaxProfitYen = netSalesYen - input.platformFeesYen - input.operatingCostsYen;
  return { netSalesYen, pretaxProfitYen, unresolved };
}

/** 目標との差。利益が確定できない場合は null を返す。 */
export function goalGap(pretaxProfitYen: Yen | null, monthlyGoalYen: Yen): Yen | null {
  if (pretaxProfitYen === null) return null;
  assertYen(monthlyGoalYen, 'monthlyGoalYen');
  return pretaxProfitYen - monthlyGoalYen;
}

export function formatYen(value: Yen | null): string {
  if (value === null) return '—';
  return `${value < 0 ? '-' : ''}¥${Math.abs(value).toLocaleString('ja-JP')}`;
}
