/**
 * Threads アダプター。
 *
 * 公式の投稿手順は「コンテナ作成 → 状態確認 → 公開」の3段階。
 *   1. POST /{user-id}/threads         media_type=TEXT&text=... → creation_id
 *   2. GET  /{creation_id}?fields=status → FINISHED になるまで確認
 *   3. POST /{user-id}/threads_publish creation_id=... → 投稿ID
 *
 * 途中で中断した場合、コンテナIDを provider_state に残しておき、
 * 再開時は同じコンテナを使う。手順3を送ったあとに結果が分からなくなったら
 * 再送せず UNKNOWN にする（再送すると二重投稿になる）。
 *
 * エンドポイントとフィールド名は環境変数で差し替えられるようにしてある。
 * 本番接続の前に、必ず現行の公式ドキュメントで確認すること。
 */

import type { PublishAdapter, PublishOutcome, ReconcileOutcome } from './types.ts';
import { classifyTransportError } from './types.ts';
import { requestJson, withTimeout, readString } from './http.ts';

const API_BASE = process.env.THREADS_API_BASE ?? 'https://graph.threads.net/v1.0';
const REQUEST_TIMEOUT_MS = 20_000;
const STATUS_POLL_ATTEMPTS = 6;
const STATUS_POLL_INTERVAL_MS = 2_000;

export type ThreadsCredentials = {
  userId: string;
  accessToken: string;
};

type ThreadsState = {
  creationId?: string;
  /** 公開リクエストを送ったかどうか。送っていたら再送しない。 */
  publishRequested?: boolean;
};

export function createThreadsAdapter(credentials: ThreadsCredentials): PublishAdapter {
  return {
    platform: 'threads',
    mode: 'live',

    async publish(request): Promise<PublishOutcome> {
      const state = { ...(request.providerState as ThreadsState) };
      const timeout = withTimeout(request.signal, REQUEST_TIMEOUT_MS);

      try {
        // 公開リクエスト送信済みなら、結果が分からないまま再送しない。
        if (state.publishRequested) {
          return {
            outcome: 'UNKNOWN',
            errorCode: 'publish_already_requested',
            detail: 'すでに公開リクエストを送信済みです。再送せず外部の状態を照合します。',
            providerState: state,
          };
        }

        // 1. コンテナ作成（すでにあれば再利用する）
        if (!state.creationId) {
          const created = await requestJson(`${API_BASE}/${credentials.userId}/threads`, {
            method: 'POST',
            signal: timeout.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              media_type: 'TEXT',
              text: request.body,
              access_token: credentials.accessToken,
            }),
          });
          const creationId = readString(created.body, 'id');
          if (!creationId) {
            return {
              outcome: 'FAILED',
              errorCode: 'container_create_failed',
              detail: `コンテナIDを取得できませんでした: ${created.raw.slice(0, 300)}`,
              sentToProvider: true,
              providerState: state,
            };
          }
          state.creationId = creationId;
        }

        // 2. 状態確認。FINISHED になるまで待つ。
        let status: string | null = null;
        for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
          const checked = await requestJson(
            `${API_BASE}/${state.creationId}?fields=status,error_message&access_token=${encodeURIComponent(credentials.accessToken)}`,
            { method: 'GET', signal: timeout.signal },
          );
          status = readString(checked.body, 'status');
          if (status === 'FINISHED') break;
          if (status === 'ERROR' || status === 'EXPIRED') {
            return {
              outcome: 'FAILED',
              errorCode: `container_${String(status).toLowerCase()}`,
              detail: readString(checked.body, 'error_message') ?? `コンテナの状態: ${status}`,
              sentToProvider: true,
              providerState: state,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
        }

        if (status !== 'FINISHED') {
          // まだ公開していないので、次回同じコンテナで再開できる。
          return {
            outcome: 'FAILED',
            errorCode: 'container_not_ready',
            detail: `コンテナが公開可能になりませんでした（最後の状態: ${status ?? '不明'}）。`,
            sentToProvider: true,
            providerState: state,
          };
        }

        // 3. 公開。ここから先は再送してはいけない。
        state.publishRequested = true;
        const publishResult = await requestJson(`${API_BASE}/${credentials.userId}/threads_publish`, {
          method: 'POST',
          signal: timeout.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            creation_id: state.creationId,
            access_token: credentials.accessToken,
          }),
        });

        const externalPostId = readString(publishResult.body, 'id');
        if (!externalPostId) {
          return {
            outcome: 'UNKNOWN',
            errorCode: 'publish_id_missing',
            detail: `公開の応答に投稿IDがありません: ${publishResult.raw.slice(0, 300)}`,
            providerState: state,
          };
        }
        return { outcome: 'PUBLISHED', externalPostId, providerState: state };
      } catch (error) {
        const classified = classifyTransportError(error);
        if (classified.unknown || state.publishRequested) {
          return {
            outcome: 'UNKNOWN',
            errorCode: classified.code,
            detail: classified.detail,
            providerState: state,
          };
        }
        return {
          outcome: 'FAILED',
          errorCode: classified.code,
          detail: classified.detail,
          sentToProvider: true,
          providerState: state,
        };
      } finally {
        timeout.dispose();
      }
    },

    async reconcile(request): Promise<ReconcileOutcome> {
      const state = request.providerState as ThreadsState;
      if (!state.creationId) return { found: false };
      const timeout = withTimeout(request.signal, REQUEST_TIMEOUT_MS);
      try {
        // コンテナから公開後の投稿IDを引けるか確認する。
        const result = await requestJson(
          `${API_BASE}/${state.creationId}?fields=status,id&access_token=${encodeURIComponent(credentials.accessToken)}`,
          { method: 'GET', signal: timeout.signal },
        );
        const status = readString(result.body, 'status');
        if (status === 'PUBLISHED') {
          const id = readString(result.body, 'id');
          if (id) return { found: true, externalPostId: id };
        }
        if (status === 'ERROR' || status === 'EXPIRED') return { found: false };
        return { indeterminate: true, detail: `照合できませんでした（状態: ${status ?? '不明'}）。` };
      } catch (error) {
        return { indeterminate: true, detail: classifyTransportError(error).detail };
      } finally {
        timeout.dispose();
      }
    },
  };
}
