/**
 * 投稿ワーカー。
 *
 * 送信までの順序を守ることが要点:
 *   1. ジョブを原子的に claim する（期限付き）
 *   2. 投稿を CLAIMED にする
 *   3. 停止フラグ・期限・文字数を「送信直前に」もう一度確認する
 *   4. attempt を永続化する（外部へ送る前）
 *   5. PUBLISHING にしてから送信する
 *   6. 結果で PUBLISHED / FAILED / UNKNOWN へ分岐する
 *
 * UNKNOWN は再送しない。照合ジョブを積み、外部の公開状態と突き合わせる。
 */

import type { PoolClient } from 'pg';
import { withTransaction, getPool } from '../db/pool.ts';
import { claimJob, finishJob, releaseJob, enqueueJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { recordAudit } from '../db/audit.ts';
import { getStopFlags } from '../db/settings.ts';
import { evaluateSendGate, isExpired } from '../domain/policy.ts';
import type { Platform } from '../domain/text-length.ts';
import type { PublishAdapter } from '../adapters/types.ts';
import { createSimulatedAdapter } from '../adapters/simulated.ts';
import { createThreadsAdapter } from '../adapters/threads.ts';
import { createXAdapter } from '../adapters/x.ts';
import { decryptSecret } from '../lib/crypto.ts';

export type AdapterFactory = (
  ownerId: string,
  platform: Platform,
) => Promise<{ adapter: PublishAdapter; mode: 'live' | 'simulated' | 'disconnected' }>;

/** 設定に従ってアダプターを組み立てる。未接続なら送信しない。 */
export const defaultAdapterFactory: AdapterFactory = async (ownerId, platform) => {
  const { rows } = await getPool().query<{
    connection_mode: 'disconnected' | 'simulated' | 'live';
    external_user_id: string | null;
    access_token_enc: string | null;
  }>(
    `SELECT connection_mode, external_user_id, access_token_enc
       FROM accounts WHERE owner_id = $1 AND platform = $2`,
    [ownerId, platform],
  );
  const account = rows[0];
  if (!account || account.connection_mode === 'disconnected') {
    return { adapter: createSimulatedAdapter(platform), mode: 'disconnected' };
  }
  if (account.connection_mode === 'simulated') {
    return { adapter: createSimulatedAdapter(platform), mode: 'simulated' };
  }
  if (!account.access_token_enc || !account.external_user_id) {
    // 本番指定でも資格情報が無ければ送らない。
    return { adapter: createSimulatedAdapter(platform), mode: 'disconnected' };
  }
  const accessToken = decryptSecret(account.access_token_enc);
  const adapter = platform === 'threads'
    ? createThreadsAdapter({ userId: account.external_user_id, accessToken })
    : createXAdapter({ userId: account.external_user_id, accessToken });
  return { adapter, mode: 'live' };
};

export type ProcessResult =
  | { kind: 'idle' }
  | { kind: 'published'; variantId: string; externalPostId: string; mode: string }
  | { kind: 'failed'; variantId: string; errorCode: string }
  | { kind: 'unknown'; variantId: string; errorCode: string }
  | { kind: 'skipped'; variantId: string; reason: string };

export type WorkerOptions = {
  workerId: string;
  adapterFactory?: AdapterFactory;
  now?: () => Date;
  signal?: AbortSignal;
};

type VariantForPublish = {
  id: string;
  owner_id: string;
  platform: Platform;
  body: string;
  state: string;
  scheduled_at: Date | null;
  provider_state: Record<string, unknown>;
};

/** publish ジョブを1件処理する。処理対象が無ければ idle。 */
export async function processOnePublishJob(options: WorkerOptions): Promise<ProcessResult> {
  const now = options.now ?? (() => new Date());
  const adapterFactory = options.adapterFactory ?? defaultAdapterFactory;

  const job = await claimJob(options.workerId, { kinds: ['publish'] });
  if (!job) return { kind: 'idle' };

  // --- 2. 投稿を CLAIMED にする（別のワーカーが触れないようにする） ---
  const claimed = await claimVariant(job, now());
  if (!claimed.ok) {
    await finishJob(job.id, 'DONE', claimed.reason);
    return { kind: 'skipped', variantId: job.ref_id, reason: claimed.reason };
  }
  const variant = claimed.variant;

  // --- 3. 送信直前の確認 ---
  const [{ globalStop, platformStop }, { adapter, mode }] = await Promise.all([
    getStopFlags(variant.owner_id, variant.platform),
    adapterFactory(variant.owner_id, variant.platform),
  ]);

  const gate = evaluateSendGate({
    platform: variant.platform,
    body: variant.body,
    scheduledAt: variant.scheduled_at ?? now(),
    now: now(),
    globalStop,
    platformStop,
    connectionMode: mode,
  });

  if (!gate.allowed) {
    if (gate.code === 'expired') {
      await setVariantState(variant.id, 'EXPIRED', { last_error: gate.message });
      await finishJob(job.id, 'CANCELLED', gate.message);
      return { kind: 'skipped', variantId: variant.id, reason: gate.code };
    }
    // 停止・未接続・不正な本文は、まだ何も送っていないので予約へ戻す。
    await setVariantState(variant.id, 'SCHEDULED', { last_error: gate.message });
    await releaseJob(job.id, new Date(now().getTime() + 60_000));
    await recordAudit({
      ownerId: variant.owner_id, actor: 'worker', action: 'publish.blocked',
      targetType: 'post_variant', targetId: variant.id, detail: { code: gate.code },
    });
    return { kind: 'skipped', variantId: variant.id, reason: gate.code };
  }

  // --- 4. attempt を永続化する（外部へ送る前） ---
  const attempt = await createAttempt(variant.id, variant.owner_id);

  // --- 5. PUBLISHING にしてから送信する ---
  await setVariantState(variant.id, 'PUBLISHING');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let outcome;
  try {
    outcome = await adapter.publish({
      idempotencyKey: attempt.idempotencyKey,
      body: variant.body,
      providerState: variant.provider_state,
      signal: controller.signal,
    });
  } catch (error) {
    // アダプターが例外を投げた場合も、送信済みかどうか分からない。
    outcome = {
      outcome: 'UNKNOWN' as const,
      errorCode: 'adapter_threw',
      detail: error instanceof Error ? error.message : String(error),
      providerState: variant.provider_state,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }

  // --- 6. 結果で分岐する ---
  if (outcome.outcome === 'PUBLISHED') {
    await finishAttempt(attempt.id, 'PUBLISHED', { externalPostId: outcome.externalPostId, sentToProvider: true });
    await setVariantState(variant.id, 'PUBLISHED', {
      external_post_id: outcome.externalPostId,
      provider_state: outcome.providerState,
      published: true,
    });
    await finishJob(job.id, 'DONE');
    await enqueueMetricJobs(variant.owner_id, variant.id, now());
    await recordAudit({
      ownerId: variant.owner_id, actor: 'worker', action: 'publish.published',
      targetType: 'post_variant', targetId: variant.id,
      detail: { externalPostId: outcome.externalPostId, mode },
    });
    return { kind: 'published', variantId: variant.id, externalPostId: outcome.externalPostId, mode };
  }

  if (outcome.outcome === 'FAILED') {
    await finishAttempt(attempt.id, 'FAILED', {
      errorCode: outcome.errorCode,
      errorDetail: outcome.detail,
      sentToProvider: outcome.sentToProvider,
    });
    await setVariantState(variant.id, 'FAILED', {
      last_error: `${outcome.errorCode}: ${outcome.detail}`,
      provider_state: outcome.providerState,
    });
    await finishJob(job.id, 'FAILED', outcome.errorCode);
    return { kind: 'failed', variantId: variant.id, errorCode: outcome.errorCode };
  }

  // UNKNOWN: 再送しない。照合ジョブを積む。
  await finishAttempt(attempt.id, 'UNKNOWN', {
    errorCode: outcome.errorCode,
    errorDetail: outcome.detail,
    sentToProvider: true,
  });
  await setVariantState(variant.id, 'UNKNOWN', {
    last_error: `${outcome.errorCode}: ${outcome.detail}`,
    provider_state: outcome.providerState,
  });
  await finishJob(job.id, 'FAILED', `unknown: ${outcome.errorCode}`);
  await enqueueJob({ ownerId: variant.owner_id, kind: 'reconcile', refId: variant.id });
  await recordAudit({
    ownerId: variant.owner_id, actor: 'worker', action: 'publish.unknown',
    targetType: 'post_variant', targetId: variant.id, detail: { errorCode: outcome.errorCode },
  });
  return { kind: 'unknown', variantId: variant.id, errorCode: outcome.errorCode };
}

async function claimVariant(
  job: Job,
  now: Date,
): Promise<{ ok: true; variant: VariantForPublish } | { ok: false; reason: string }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<VariantForPublish>(
      `SELECT id, owner_id, platform, body, state, scheduled_at, provider_state
         FROM post_variants WHERE id = $1 FOR UPDATE`,
      [job.ref_id],
    );
    const variant = rows[0];
    if (!variant) return { ok: false as const, reason: 'variant not found' };
    if (variant.state !== 'SCHEDULED') {
      return { ok: false as const, reason: `variant is ${variant.state}, not SCHEDULED` };
    }
    if (variant.scheduled_at && isExpired(variant.scheduled_at, now)) {
      await client.query(
        `UPDATE post_variants SET state = 'EXPIRED', last_error = '予約時刻から24時間以上経過', updated_at = now()
          WHERE id = $1`,
        [variant.id],
      );
      return { ok: false as const, reason: 'expired' };
    }
    await client.query(
      `UPDATE post_variants SET state = 'CLAIMED', updated_at = now() WHERE id = $1`,
      [variant.id],
    );
    return { ok: true as const, variant: { ...variant, state: 'CLAIMED' } };
  });
}

async function createAttempt(variantId: string, ownerId: string): Promise<{ id: string; idempotencyKey: string }> {
  return withTransaction(async (client: PoolClient) => {
    const { rows: prior } = await client.query<{ next: string }>(
      `SELECT (COALESCE(MAX(attempt_no), 0) + 1)::text AS next FROM publish_attempts WHERE variant_id = $1`,
      [variantId],
    );
    const attemptNo = Number(prior[0].next);
    // 冪等キーは (投稿, 試行番号) から決まる。同じ試行は同じ鍵になる。
    const idempotencyKey = `publish:${variantId}:${attemptNo}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO publish_attempts (owner_id, variant_id, attempt_no, idempotency_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [ownerId, variantId, attemptNo, idempotencyKey],
    );
    return { id: rows[0].id, idempotencyKey };
  });
}

async function finishAttempt(
  attemptId: string,
  outcome: 'PUBLISHED' | 'FAILED' | 'UNKNOWN',
  detail: { externalPostId?: string; errorCode?: string; errorDetail?: string; sentToProvider: boolean },
): Promise<void> {
  await getPool().query(
    `UPDATE publish_attempts
        SET finished_at = now(), outcome = $2, external_post_id = $3,
            error_code = $4, error_detail = $5, sent_to_provider = $6
      WHERE id = $1`,
    [attemptId, outcome, detail.externalPostId ?? null, detail.errorCode ?? null,
     detail.errorDetail ?? null, detail.sentToProvider],
  );
}

async function setVariantState(
  variantId: string,
  state: string,
  patch: {
    external_post_id?: string;
    last_error?: string;
    provider_state?: Record<string, unknown>;
    published?: boolean;
  } = {},
): Promise<void> {
  await getPool().query(
    `UPDATE post_variants
        SET state = $2,
            external_post_id = COALESCE($3, external_post_id),
            last_error = $4,
            provider_state = COALESCE($5::jsonb, provider_state),
            published_at = CASE WHEN $6 THEN now() ELSE published_at END,
            updated_at = now()
      WHERE id = $1`,
    [
      variantId, state, patch.external_post_id ?? null, patch.last_error ?? null,
      patch.provider_state ? JSON.stringify(patch.provider_state) : null,
      patch.published === true,
    ],
  );
}

/** 公開後、同じ経過時間で比較できるように指標取得を予約する。 */
async function enqueueMetricJobs(ownerId: string, variantId: string, now: Date): Promise<void> {
  await enqueueJob({
    ownerId,
    kind: 'collect_metrics',
    refId: variantId,
    runAfter: new Date(now.getTime() + 60 * 60_000),
  });
}

/**
 * UNKNOWN の投稿を外部と照合する。
 * 照合できないうちは UNKNOWN のままにして、再送も確定もしない。
 */
export async function processOneReconcileJob(options: WorkerOptions): Promise<ProcessResult> {
  const adapterFactory = options.adapterFactory ?? defaultAdapterFactory;
  const job = await claimJob(options.workerId, { kinds: ['reconcile'] });
  if (!job) return { kind: 'idle' };

  const { rows } = await getPool().query<VariantForPublish>(
    `SELECT id, owner_id, platform, body, state, scheduled_at, provider_state
       FROM post_variants WHERE id = $1`,
    [job.ref_id],
  );
  const variant = rows[0];
  if (!variant) {
    await finishJob(job.id, 'CANCELLED', 'variant not found');
    return { kind: 'skipped', variantId: job.ref_id, reason: 'not found' };
  }
  if (variant.state !== 'UNKNOWN') {
    await finishJob(job.id, 'DONE', `variant is ${variant.state}`);
    return { kind: 'skipped', variantId: variant.id, reason: `state=${variant.state}` };
  }

  const { adapter, mode } = await adapterFactory(variant.owner_id, variant.platform);
  if (mode === 'disconnected') {
    // 照合できないので状態を変えない。後で再試行する。
    await releaseJob(job.id, new Date(Date.now() + 30 * 60_000));
    return { kind: 'skipped', variantId: variant.id, reason: 'disconnected' };
  }

  const lastAttempt = await getPool().query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM publish_attempts
      WHERE variant_id = $1 ORDER BY attempt_no DESC LIMIT 1`,
    [variant.id],
  );

  const controller = new AbortController();
  const result = await adapter.reconcile({
    idempotencyKey: lastAttempt.rows[0]?.idempotency_key ?? '',
    body: variant.body,
    providerState: variant.provider_state,
    signal: controller.signal,
  });

  if ('indeterminate' in result) {
    // 分からないままなら確定させず、時間をおいて再試行する。
    await releaseJob(job.id, new Date(Date.now() + 30 * 60_000));
    return { kind: 'skipped', variantId: variant.id, reason: 'indeterminate' };
  }

  if (result.found) {
    await setVariantState(variant.id, 'PUBLISHED', {
      external_post_id: result.externalPostId,
      published: true,
    });
    await finishJob(job.id, 'DONE', 'reconciled as published');
    await recordAudit({
      ownerId: variant.owner_id, actor: 'reconciler', action: 'reconcile.published',
      targetType: 'post_variant', targetId: variant.id, detail: { externalPostId: result.externalPostId },
    });
    return { kind: 'published', variantId: variant.id, externalPostId: result.externalPostId, mode };
  }

  await setVariantState(variant.id, 'FAILED', { last_error: '外部に該当の投稿が見つかりませんでした。' });
  await finishJob(job.id, 'DONE', 'reconciled as not published');
  await recordAudit({
    ownerId: variant.owner_id, actor: 'reconciler', action: 'reconcile.not_found',
    targetType: 'post_variant', targetId: variant.id,
  });
  return { kind: 'failed', variantId: variant.id, errorCode: 'not_found' };
}
