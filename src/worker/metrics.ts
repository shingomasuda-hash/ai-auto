/**
 * 指標取得ジョブ。
 *
 * 公開後の経過時間をそろえて比較できるよう、決まったバケット
 * (1h/24h/72h/168h)で取得する。取得できない指標は NULL のまま保存する。
 * 内部のクリック数は媒体の指標ではないので、click_events から別に数える。
 */

import { getPool } from '../db/pool.ts';
import { claimJob, finishJob, enqueueJob, releaseJob } from '../db/jobs.ts';
import { ELAPSED_BUCKETS_HOURS } from '../domain/metrics.ts';
import type { ElapsedBucketHours } from '../domain/metrics.ts';
import { HOUR_MS } from '../domain/time.ts';
import type { Platform } from '../domain/text-length.ts';
import type { MetricsAdapter } from '../adapters/metrics.ts';
import {
  createSimulatedMetricsAdapter, createThreadsMetricsAdapter, createXMetricsAdapter,
} from '../adapters/metrics.ts';
import { decryptSecret } from '../lib/crypto.ts';

export type MetricsAdapterFactory = (
  ownerId: string,
  platform: Platform,
) => Promise<{ adapter: MetricsAdapter; mode: 'live' | 'simulated' | 'disconnected' }>;

export const defaultMetricsAdapterFactory: MetricsAdapterFactory = async (ownerId, platform) => {
  const { rows } = await getPool().query<{
    connection_mode: 'disconnected' | 'simulated' | 'live';
    access_token_enc: string | null;
  }>(
    `SELECT connection_mode, access_token_enc FROM accounts WHERE owner_id = $1 AND platform = $2`,
    [ownerId, platform],
  );
  const account = rows[0];
  if (!account || account.connection_mode !== 'live' || !account.access_token_enc) {
    return {
      adapter: createSimulatedMetricsAdapter(platform),
      mode: account?.connection_mode === 'simulated' ? 'simulated' : 'disconnected',
    };
  }
  const token = decryptSecret(account.access_token_enc);
  return {
    adapter: platform === 'threads' ? createThreadsMetricsAdapter(token) : createXMetricsAdapter(token),
    mode: 'live',
  };
};

/** 公開からの経過時間に対応するバケットを選ぶ。 */
export function bucketForElapsed(elapsedMs: number): ElapsedBucketHours | null {
  let chosen: ElapsedBucketHours | null = null;
  for (const hours of ELAPSED_BUCKETS_HOURS) {
    if (elapsedMs >= hours * HOUR_MS) chosen = hours;
  }
  return chosen;
}

/** 次のバケットまでの待ち時間。すべて終わっていれば null。 */
export function nextBucketDelayMs(elapsedMs: number): number | null {
  for (const hours of ELAPSED_BUCKETS_HOURS) {
    const target = hours * HOUR_MS;
    if (elapsedMs < target) return target - elapsedMs;
  }
  return null;
}

export type MetricsResult =
  | { kind: 'idle' }
  | { kind: 'captured'; variantId: string; bucketHours: ElapsedBucketHours }
  | { kind: 'skipped'; variantId: string; reason: string };

export async function processOneMetricsJob(options: {
  workerId: string;
  adapterFactory?: MetricsAdapterFactory;
  now?: () => Date;
}): Promise<MetricsResult> {
  const now = (options.now ?? (() => new Date()))();
  const adapterFactory = options.adapterFactory ?? defaultMetricsAdapterFactory;

  const job = await claimJob(options.workerId, { kinds: ['collect_metrics'] });
  if (!job) return { kind: 'idle' };

  const { rows } = await getPool().query<{
    id: string; owner_id: string; platform: Platform;
    external_post_id: string | null; published_at: Date | null; state: string;
  }>(
    `SELECT id, owner_id, platform, external_post_id, published_at, state
       FROM post_variants WHERE id = $1`,
    [job.ref_id],
  );
  const variant = rows[0];

  if (!variant || variant.state !== 'PUBLISHED' || !variant.external_post_id || !variant.published_at) {
    await finishJob(job.id, 'CANCELLED', '公開済みではないため取得しません。');
    return { kind: 'skipped', variantId: job.ref_id, reason: 'not published' };
  }

  const elapsedMs = now.getTime() - variant.published_at.getTime();
  const bucket = bucketForElapsed(elapsedMs);
  if (bucket === null) {
    // まだ最初のバケットに達していない。時間をおいて再試行する。
    const delay = nextBucketDelayMs(elapsedMs) ?? HOUR_MS;
    await releaseJob(job.id, new Date(now.getTime() + delay));
    return { kind: 'skipped', variantId: variant.id, reason: 'too early' };
  }

  const { adapter, mode } = await adapterFactory(variant.owner_id, variant.platform);
  if (mode === 'disconnected') {
    await finishJob(job.id, 'CANCELLED', '未接続のため取得しません。');
    return { kind: 'skipped', variantId: variant.id, reason: 'disconnected' };
  }

  const controller = new AbortController();
  const fetched = await adapter.fetchMetrics({ externalPostId: variant.external_post_id, signal: controller.signal });

  if (!fetched.ok) {
    // 取得できなかったことを記録し、後で再試行する。0では埋めない。
    await releaseJob(job.id, new Date(now.getTime() + 30 * 60_000));
    return { kind: 'skipped', variantId: variant.id, reason: fetched.reason };
  }

  // 内部クリックは媒体の指標ではなく、自前の click_events から数える。
  const clicks = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM click_events WHERE variant_id = $1`,
    [variant.id],
  );
  const linkClicks = Number(clicks.rows[0].count);

  await getPool().query(
    `INSERT INTO metric_snapshots
       (owner_id, variant_id, captured_at, elapsed_bucket_hours,
        impressions, likes, replies, reposts, link_clicks, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (variant_id, elapsed_bucket_hours) DO UPDATE
       SET captured_at = EXCLUDED.captured_at,
           impressions = EXCLUDED.impressions,
           likes = EXCLUDED.likes,
           replies = EXCLUDED.replies,
           reposts = EXCLUDED.reposts,
           link_clicks = EXCLUDED.link_clicks,
           raw = EXCLUDED.raw`,
    [
      variant.owner_id, variant.id, now, bucket,
      fetched.values.impressions, fetched.values.likes, fetched.values.replies,
      fetched.values.reposts, linkClicks,
      JSON.stringify(fetched.raw ?? {}),
    ],
  );

  await finishJob(job.id, 'DONE');

  // 次のバケットの取得を予約する。
  const delay = nextBucketDelayMs(elapsedMs);
  if (delay !== null) {
    await enqueueJob({
      ownerId: variant.owner_id,
      kind: 'collect_metrics',
      refId: variant.id,
      runAfter: new Date(now.getTime() + delay),
    });
  }

  return { kind: 'captured', variantId: variant.id, bucketHours: bucket };
}
