/** アダプター共通のHTTP処理。タイムアウトと分類を一箇所に集める。 */

import { RateLimitError, TokenExpiredError, classifyHttpStatus } from './types.ts';

export type HttpResult = {
  status: number;
  body: unknown;
  raw: string;
};

export async function requestJson(
  url: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<HttpResult> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw === '' ? null : JSON.parse(raw);
  } catch {
    body = null;
  }

  const kind = classifyHttpStatus(response.status);
  if (kind === 'auth') {
    throw new TokenExpiredError(`認可エラー(${response.status}): ${raw.slice(0, 300)}`);
  }
  if (kind === 'rate_limited') {
    const retryAfter = Number(response.headers.get('retry-after') ?? '');
    const reset = Number(response.headers.get('x-rate-limit-reset') ?? '');
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Number.isFinite(reset) && reset > 0
        ? Math.max(0, reset * 1000 - Date.now())
        : 15 * 60_000;
    throw new RateLimitError(retryAfterMs, `レート制限(429)。${Math.round(retryAfterMs / 1000)}秒後に再試行してください。`);
  }

  return { status: response.status, body, raw };
}

/**
 * タイムアウト付きの AbortSignal。
 * 呼び出し側の signal と合成し、どちらでも中断できるようにする。
 */
export function withTimeout(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'AbortError')), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

export function readString(body: unknown, ...path: string[]): string | null {
  let current: unknown = body;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}
