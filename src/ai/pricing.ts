/**
 * AI呼出しの見込額を「円」で算出する。
 *
 * 重要: 料金表と為替レートは、運用者が明示的に登録するまで「未登録」とする。
 * 推測した単価で自動課金を進めないため、未登録なら見込額を返さず、
 * 呼び出し側が有料処理を止める。
 *
 * 登録は環境変数で行う:
 *   AI_PRICE_INPUT_PER_MTOK   入力100万トークンあたりの単価
 *   AI_PRICE_OUTPUT_PER_MTOK  出力100万トークンあたりの単価
 *   AI_PRICE_CURRENCY         単価の通貨(JPY なら為替不要)
 *   AI_FX_RATE_TO_JPY         1通貨あたりの円レート(JPY以外のとき必須)
 */

import type { PricingStatus } from '../domain/budget.ts';

export type TokenEstimate = {
  inputTokens: number;
  /** 上限まで使われる前提で見込む(max_tokens)。 */
  maxOutputTokens: number;
};

export type PricingTable =
  | { registered: true; inputPerMTok: number; outputPerMTok: number; currency: string; fxRateToJpy: number }
  | { registered: false; reason: 'pricing_unregistered' | 'fx_rate_unregistered' };

export type EnvLike = Record<string, string | undefined>;

export function loadPricingTable(env: EnvLike = process.env): PricingTable {
  const input = Number(env.AI_PRICE_INPUT_PER_MTOK ?? '');
  const output = Number(env.AI_PRICE_OUTPUT_PER_MTOK ?? '');
  const currency = (env.AI_PRICE_CURRENCY ?? '').trim().toUpperCase();

  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0 || currency === '') {
    return { registered: false, reason: 'pricing_unregistered' };
  }

  if (currency === 'JPY') {
    return { registered: true, inputPerMTok: input, outputPerMTok: output, currency, fxRateToJpy: 1 };
  }

  const fx = Number(env.AI_FX_RATE_TO_JPY ?? '');
  if (!Number.isFinite(fx) || fx <= 0) {
    return { registered: false, reason: 'fx_rate_unregistered' };
  }
  return { registered: true, inputPerMTok: input, outputPerMTok: output, currency, fxRateToJpy: fx };
}

/**
 * 最大見込額(円)。切り上げる。
 * 出力は max_tokens ぶん使われる前提で見込む（安全側）。
 */
export function estimateYen(estimate: TokenEstimate, table: PricingTable): PricingStatus {
  if (!table.registered) return { known: false, reason: table.reason };
  if (estimate.inputTokens < 0 || estimate.maxOutputTokens < 0) {
    return { known: false, reason: 'estimate_unavailable' };
  }

  const cost =
    (estimate.inputTokens / 1_000_000) * table.inputPerMTok +
    (estimate.maxOutputTokens / 1_000_000) * table.outputPerMTok;

  return { known: true, estimateYen: Math.ceil(cost * table.fxRateToJpy) };
}

/** 実績額(円)。切り上げる。 */
export function actualYen(
  usage: { inputTokens: number; outputTokens: number },
  table: PricingTable,
): number | null {
  if (!table.registered) return null;
  const cost =
    (usage.inputTokens / 1_000_000) * table.inputPerMTok +
    (usage.outputTokens / 1_000_000) * table.outputPerMTok;
  return Math.ceil(cost * table.fxRateToJpy);
}

/**
 * 入力トークン数の概算。
 * 正確な数はAPIの応答でしか分からないので、多めに見積もる。
 */
export function roughTokenCount(text: string): number {
  // 日本語は1文字≒1トークンを超えることがある。安全側に倒して1.5倍で見る。
  return Math.ceil(Array.from(text).length * 1.5) + 16;
}
