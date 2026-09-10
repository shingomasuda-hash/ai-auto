/**
 * X アダプター。
 *
 * ユーザー権限のアクセストークンで POST /2/tweets に本文を送る。
 * 応答の data.id が投稿ID。
 *
 * 重要: 応答が得られなかった場合、投稿されたかどうかは分からない。
 * 無条件に再送すると二重投稿になるため、必ず UNKNOWN として隔離する。
 *
 * エンドポイントは環境変数で差し替えられる。本番接続の前に現行の
 * 公式ドキュメントで確認すること。
 */

import type { PublishAdapter, PublishOutcome, ReconcileOutcome } from './types.ts';
import { classifyTransportError } from './types.ts';
import { requestJson, withTimeout, readString } from './http.ts';

const API_BASE = process.env.X_API_BASE ?? 'https://api.x.com/2';
const REQUEST_TIMEOUT_MS = 20_000;

export type XCredentials = {
  accessToken: string;
  /** 照合に使う自分のユーザーID。 */
  userId: string;
};

type XState = {
  /** 送信リクエストを開始したかどうか。 */
  sendRequested?: boolean;
};

export function createXAdapter(credentials: XCredentials): PublishAdapter {
  return {
    platform: 'x',
    mode: 'live',

    async publish(request): Promise<PublishOutcome> {
      const state = { ...(request.providerState as XState) };

      if (state.sendRequested) {
        // 一度でも送信を開始していたら、結果が不明なまま再送しない。
        return {
          outcome: 'UNKNOWN',
          errorCode: 'send_already_requested',
          detail: 'すでに送信を開始しています。再送せず外部の状態を照合します。',
          providerState: state,
        };
      }

      const timeout = withTimeout(request.signal, REQUEST_TIMEOUT_MS);
      try {
        state.sendRequested = true;
        const result = await requestJson(`${API_BASE}/tweets`, {
          method: 'POST',
          signal: timeout.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${credentials.accessToken}`,
          },
          body: JSON.stringify({ text: request.body }),
        });

        const externalPostId = readString(result.body, 'data', 'id');
        if (externalPostId) {
          return { outcome: 'PUBLISHED', externalPostId, providerState: state };
        }

        // 2xx なのにIDが無い場合は、投稿されたかどうか判断できない。
        return {
          outcome: 'UNKNOWN',
          errorCode: 'post_id_missing',
          detail: `応答に投稿IDがありません: ${result.raw.slice(0, 300)}`,
          providerState: state,
        };
      } catch (error) {
        const classified = classifyTransportError(error);
        if (classified.unknown) {
          return {
            outcome: 'UNKNOWN',
            errorCode: classified.code,
            detail: classified.detail,
            providerState: state,
          };
        }
        // 4xx / 認可エラー / レート制限は「受け付けられなかった」ことが明確。
        return {
          outcome: 'FAILED',
          errorCode: classified.code,
          detail: classified.detail,
          sentToProvider: true,
          providerState: state,
          retryAfterMs: classified.code === 'rate_limited' && error instanceof Error && 'retryAfterMs' in error
            ? (error as { retryAfterMs: number }).retryAfterMs
            : undefined,
        };
      } finally {
        timeout.dispose();
      }
    },

    async reconcile(request): Promise<ReconcileOutcome> {
      const timeout = withTimeout(request.signal, REQUEST_TIMEOUT_MS);
      try {
        // 直近の自分の投稿を取得し、同じ本文があるか調べる。
        const result = await requestJson(
          `${API_BASE}/users/${credentials.userId}/tweets?max_results=25&tweet.fields=text,created_at`,
          {
            method: 'GET',
            signal: timeout.signal,
            headers: { authorization: `Bearer ${credentials.accessToken}` },
          },
        );
        const data = (result.body as { data?: { id: string; text: string }[] } | null)?.data;
        if (!Array.isArray(data)) {
          return { indeterminate: true, detail: '直近の投稿一覧を取得できませんでした。' };
        }
        // 本文の一致で判定する。短縮URL等で変形しうるので前方一致も見る。
        const target = request.body.trim();
        const match = data.find((item) => item.text.trim() === target || target.startsWith(item.text.trim().slice(0, 40)));
        if (match) return { found: true, externalPostId: match.id };
        // 一覧に無くても、取得範囲外の可能性がある。断定しない。
        return { indeterminate: true, detail: '直近の投稿一覧に該当がありませんでした。範囲外の可能性があります。' };
      } catch (error) {
        return { indeterminate: true, detail: classifyTransportError(error).detail };
      } finally {
        timeout.dispose();
      }
    },
  };
}
