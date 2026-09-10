/**
 * 月次予算の管理（純粋な計算部分）。
 *
 * 方針:
 *  - 有料呼出しの「前」に最大見込額を予約する。
 *  - 使用済 + 予約済 + 新規見込 が枠を超えるなら拒否する。
 *  - 完了後に実績で精算する。
 *  - 失敗しても課金有無が不明なら予約を解放しない（UNSETTLED として残す）。
 *  - 料金表・為替が未登録なら見込額を計算できないので有料処理を止める。
 *
 * ここに書かれた枠は「自社の予算配分」であって各社の料金ではない。
 */

import type { Yen } from './money.ts';
import { assertYen } from './money.ts';

export const BUDGET_CATEGORIES = ['ai', 'x_api', 'infra', 'reserve'] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

/** 月次の総予算と内訳（円）。運営費上限は10,000円。 */
export const DEFAULT_MONTHLY_BUDGET_YEN = 10_000;

export const DEFAULT_ENVELOPES: Readonly<Record<BudgetCategory, Yen>> = {
  ai: 3_000,
  x_api: 3_000,
  infra: 2_000,
  reserve: 2_000,
};

export const WARN_RATIO = 0.8;

export type EnvelopeState = {
  category: BudgetCategory;
  /** この枠の上限。 */
  limitYen: Yen;
  /** 精算済みの実績。 */
  settledYen: Yen;
  /** 未精算の予約（進行中 + 結果不明で解放していないもの）。 */
  reservedYen: Yen;
  /** 月初に確定している固定費（先に差し引く）。 */
  fixedYen: Yen;
};

export type EnvelopeView = EnvelopeState & {
  committedYen: Yen;
  availableYen: Yen;
  usageRatio: number;
  warn: boolean;
  exhausted: boolean;
};

export function viewEnvelope(state: EnvelopeState): EnvelopeView {
  assertYen(state.limitYen, 'limitYen');
  assertYen(state.settledYen, 'settledYen');
  assertYen(state.reservedYen, 'reservedYen');
  assertYen(state.fixedYen, 'fixedYen');

  const committedYen = state.fixedYen + state.settledYen + state.reservedYen;
  const availableYen = state.limitYen - committedYen;
  const usageRatio = state.limitYen === 0 ? 1 : committedYen / state.limitYen;
  return {
    ...state,
    committedYen,
    availableYen,
    usageRatio,
    warn: usageRatio >= WARN_RATIO,
    exhausted: availableYen <= 0,
  };
}

export type PricingStatus =
  | { known: true; estimateYen: Yen }
  | { known: false; reason: 'pricing_unregistered' | 'fx_rate_unregistered' | 'estimate_unavailable' };

export type ReservationDecision =
  | { allowed: true; reserveYen: Yen; view: EnvelopeView }
  | { allowed: false; code: 'pricing_unknown'; reason: string }
  | { allowed: false; code: 'envelope_exceeded'; reason: string; availableYen: Yen; requestedYen: Yen }
  | { allowed: false; code: 'total_exceeded'; reason: string; availableYen: Yen; requestedYen: Yen };

export type ReservationRequest = {
  envelope: EnvelopeState;
  /** 月全体の使用済 + 予約済 + 固定費。 */
  monthCommittedYen: Yen;
  monthlyBudgetYen: Yen;
  pricing: PricingStatus;
  /**
   * SDKの暗黙リトライ回数を含めた係数。1 なら再試行なし。
   * 見込額には必ずリトライ分を含める。
   */
  retryFactor: number;
};

/**
 * 予約してよいかを判定する。実際の予約は必ずDBトランザクション内で行う。
 */
export function decideReservation(req: ReservationRequest): ReservationDecision {
  if (!req.pricing.known) {
    return {
      allowed: false,
      code: 'pricing_unknown',
      reason: `見込額を計算できません(${req.pricing.reason})。有料処理を停止します。`,
    };
  }
  if (!Number.isFinite(req.retryFactor) || req.retryFactor < 1) {
    throw new RangeError('retryFactor must be >= 1');
  }

  const reserveYen = Math.ceil(req.pricing.estimateYen * req.retryFactor);
  assertYen(reserveYen, 'reserveYen');

  const view = viewEnvelope(req.envelope);
  if (reserveYen > view.availableYen) {
    return {
      allowed: false,
      code: 'envelope_exceeded',
      reason: `枠「${req.envelope.category}」の残高が不足しています。`,
      availableYen: view.availableYen,
      requestedYen: reserveYen,
    };
  }

  const monthAvailable = req.monthlyBudgetYen - req.monthCommittedYen;
  if (reserveYen > monthAvailable) {
    return {
      allowed: false,
      code: 'total_exceeded',
      reason: '月次予算の残高が不足しています。',
      availableYen: monthAvailable,
      requestedYen: reserveYen,
    };
  }

  return { allowed: true, reserveYen, view };
}

export const RESERVATION_STATES = ['RESERVED', 'SETTLED', 'RELEASED', 'UNSETTLED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export type SettlementInput = {
  reservedYen: Yen;
  outcome:
    | { kind: 'success'; actualYen: Yen }
    /** 課金されていないことが確実な失敗（送信前の検証エラー等）。 */
    | { kind: 'failed_not_charged' }
    /** 課金有無が不明な失敗（タイムアウト等）。予約は解放しない。 */
    | { kind: 'failed_unknown' };
};

export type Settlement = {
  state: ReservationState;
  /** 精算後に枠へ計上される実績額。 */
  settledYen: Yen;
  /** 解放される予約額。 */
  releasedYen: Yen;
  /** 予約として残り続ける額。 */
  heldYen: Yen;
  note: string;
};

export function settle(input: SettlementInput): Settlement {
  assertYen(input.reservedYen, 'reservedYen');

  if (input.outcome.kind === 'success') {
    const actual = assertYen(input.outcome.actualYen, 'actualYen');
    // 見込より高くついた場合も実績を計上する（上限超過は警告として扱う）。
    const released = Math.max(0, input.reservedYen - actual);
    return {
      state: 'SETTLED',
      settledYen: actual,
      releasedYen: released,
      heldYen: 0,
      note: actual > input.reservedYen ? '実績が見込を超過しました。上限設定を見直してください。' : '',
    };
  }

  if (input.outcome.kind === 'failed_not_charged') {
    return {
      state: 'RELEASED',
      settledYen: 0,
      releasedYen: input.reservedYen,
      heldYen: 0,
      note: '課金なしが確認できたため予約を解放しました。',
    };
  }

  return {
    state: 'UNSETTLED',
    settledYen: 0,
    releasedYen: 0,
    heldYen: input.reservedYen,
    note: '課金有無が不明なため予約を保持します。明細で確認後に手動精算してください。',
  };
}

/**
 * 表示用の注意文。費用の反映には遅延があるため断定しない。
 */
export const BUDGET_DISCLAIMER =
  '費用の反映には各社側の遅延があります。表示は当システムが把握している範囲の概算で、上限を超えないことを保証するものではありません。';
