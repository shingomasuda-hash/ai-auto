/**
 * Anthropic Messages API の呼び出し。
 *
 * 有料呼出しなので、必ず「予約 → 呼出し → 精算」の順に通す。
 * 予約できなければ呼び出さない。
 *
 * SDKの暗黙リトライで課金が増えるのを避けるため、素の fetch を使い、
 * 再試行は行わない（RETRY_FACTOR=1）。再試行を入れる場合は必ず
 * 同じ数だけ見込額の係数を上げること。
 */

import { reserveBudget, settleReservation } from '../db/budget.ts';
import type { ReserveResult } from '../db/budget.ts';
import { loadPricingTable, estimateYen, actualYen, roughTokenCount } from './pricing.ts';
import type { PricingTable } from './pricing.ts';

const API_URL = process.env.ANTHROPIC_API_URL ?? 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 120_000;

/** 再試行しない。増やすなら見込額の係数も同じだけ上げること。 */
export const RETRY_FACTOR = 1;

export type MessageRequest = {
  ownerId: string;
  model: string;
  system: string;
  userContent: string;
  maxOutputTokens: number;
  /** 予算の枠。AI呼出しは 'ai'。 */
  purpose: string;
  /** 同じ処理を二度課金しないための鍵。 */
  idempotencyKey: string;
  refId?: string | null;
  signal?: AbortSignal;
  pricingTable?: PricingTable;
};

export type MessageResult =
  | {
      ok: true;
      text: string;
      usage: { inputTokens: number; outputTokens: number };
      costYen: number | null;
    }
  | { ok: false; code: 'budget_declined'; reason: string }
  | { ok: false; code: 'api_error'; reason: string }
  | { ok: false; code: 'unknown_billing'; reason: string };

/**
 * 予算を予約してからモデルを呼ぶ。
 *
 * 失敗時:
 *  - 呼び出す前の失敗 → 予約を解放する
 *  - 呼び出し後に課金有無が不明 → 予約を解放しない(UNSETTLED)
 */
export async function createMessage(request: MessageRequest): Promise<MessageResult> {
  const table = request.pricingTable ?? loadPricingTable();
  const pricing = estimateYen(
    {
      inputTokens: roughTokenCount(request.system) + roughTokenCount(request.userContent),
      maxOutputTokens: request.maxOutputTokens,
    },
    table,
  );

  // --- 予約 ---
  const reservation: ReserveResult = await reserveBudget({
    ownerId: request.ownerId,
    category: 'ai',
    pricing,
    retryFactor: RETRY_FACTOR,
    purpose: request.purpose,
    refId: request.refId ?? null,
    idempotencyKey: request.idempotencyKey,
  });

  if (!reservation.ok) {
    return { ok: false, code: 'budget_declined', reason: reservation.decision.reason };
  }
  const reservationId = reservation.reservation.id;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 呼び出していないので課金はない。予約を解放する。
    await settleReservation(reservationId, { kind: 'failed_not_charged' });
    return { ok: false, code: 'api_error', reason: 'ANTHROPIC_API_KEY が設定されていません。' };
  }

  // --- 呼出し ---
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'AbortError')), REQUEST_TIMEOUT_MS);
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.userContent }],
      }),
    });
  } catch (error) {
    clearTimeout(timer);
    // 送信の途中で切れた場合、課金されたかどうか分からない。
    await settleReservation(reservationId, { kind: 'failed_unknown' });
    return {
      ok: false,
      code: 'unknown_billing',
      reason: `応答を受け取れませんでした。課金有無が不明なため予約を保持します: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  clearTimeout(timer);

  const raw = await response.text();

  if (!response.ok) {
    // 4xx は課金されていないと考えてよい。5xx は不明。
    if (response.status >= 400 && response.status < 500) {
      await settleReservation(reservationId, { kind: 'failed_not_charged' });
      return { ok: false, code: 'api_error', reason: `${response.status}: ${raw.slice(0, 300)}` };
    }
    await settleReservation(reservationId, { kind: 'failed_unknown' });
    return {
      ok: false,
      code: 'unknown_billing',
      reason: `${response.status}: 課金有無が不明なため予約を保持します。`,
    };
  }

  let body: { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    body = JSON.parse(raw);
  } catch {
    await settleReservation(reservationId, { kind: 'failed_unknown' });
    return { ok: false, code: 'unknown_billing', reason: '応答を解釈できませんでした。' };
  }

  const usage = {
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
  const costYen = actualYen(usage, table);

  // --- 精算 ---
  await settleReservation(reservationId, { kind: 'success', actualYen: costYen ?? reservation.reservation.reserved_yen });

  const text = (body.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  return { ok: true, text, usage, costYen };
}
