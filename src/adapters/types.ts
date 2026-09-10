/**
 * 媒体アダプターの共通契約。
 *
 * 送信結果は必ず3種類に分ける:
 *  - PUBLISHED: 外部IDを取得できた。
 *  - FAILED: 外部が明確に失敗を返した。送信されていないことが確実。
 *  - UNKNOWN: 送信されたかどうか分からない。再送してはいけない。
 *
 * タイムアウト・ネットワーク切断・5xx は原則 UNKNOWN に倒す。
 * 「たぶん失敗した」を FAILED として扱うと二重投稿の原因になる。
 */

import type { Platform } from '../domain/text-length.ts';

export type PublishRequest = {
  /** 冪等キー。同じ試行を二度送らないための鍵。 */
  idempotencyKey: string;
  body: string;
  /** 媒体固有の途中状態（ThreadsのコンテナIDなど）。 */
  providerState: Record<string, unknown>;
  signal: AbortSignal;
};

export type PublishOutcome =
  | { outcome: 'PUBLISHED'; externalPostId: string; providerState: Record<string, unknown> }
  | {
      outcome: 'FAILED';
      errorCode: string;
      detail: string;
      /** 外部へリクエストが届いた可能性があるか。 */
      sentToProvider: boolean;
      providerState: Record<string, unknown>;
      /** 再試行してよいか（レート制限など）。 */
      retryAfterMs?: number;
    }
  | {
      outcome: 'UNKNOWN';
      errorCode: string;
      detail: string;
      providerState: Record<string, unknown>;
    };

export type ReconcileOutcome =
  | { found: true; externalPostId: string }
  | { found: false }
  | { indeterminate: true; detail: string };

export type PublishAdapter = {
  platform: Platform;
  /** 'live' なら外部へ実際に送信する。'simulated' は外部へ一切送らない。 */
  mode: 'live' | 'simulated';
  publish(request: PublishRequest): Promise<PublishOutcome>;
  /**
   * UNKNOWN になった投稿の公開状態を外部で照合する。
   * 照合できないうちは indeterminate を返し、勝手に確定させない。
   */
  reconcile(request: { idempotencyKey: string; body: string; providerState: Record<string, unknown>; signal: AbortSignal }): Promise<ReconcileOutcome>;
};

export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number, message: string) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class TokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

/**
 * fetch の結果を分類する共通処理。
 *
 * 送信の可否が分からない状況（タイムアウト、接続断、5xx、429の一部）は
 * すべて UNKNOWN 側へ倒す。
 */
export function classifyTransportError(error: unknown): { code: string; detail: string; unknown: boolean } {
  if (error instanceof TokenExpiredError) {
    return { code: 'token_expired', detail: error.message, unknown: false };
  }
  if (error instanceof RateLimitError) {
    return { code: 'rate_limited', detail: error.message, unknown: false };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    // 中断した時点で送信済みかどうかは分からない。
    return { code: 'timeout', detail: '送信がタイムアウトしました。', unknown: true };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { code: 'transport_error', detail, unknown: true };
}

/** HTTPステータスから、送信済みかどうかが判断できるかを決める。 */
export function classifyHttpStatus(status: number): 'ok' | 'failed' | 'unknown' | 'rate_limited' | 'auth' {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  // 4xx は「受け付けられなかった」ことが明確。
  if (status >= 400 && status < 500) return 'failed';
  // 5xx は受理済みかどうか分からない。
  return 'unknown';
}
