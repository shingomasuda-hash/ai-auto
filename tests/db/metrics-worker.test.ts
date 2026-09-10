import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { createPost } from '../../src/db/posts.ts';
import { enqueueJob } from '../../src/db/jobs.ts';
import { processOneMetricsJob, bucketForElapsed, nextBucketDelayMs } from '../../src/worker/metrics.ts';
import type { MetricsAdapterFactory } from '../../src/worker/metrics.ts';
import type { MetricsAdapter } from '../../src/adapters/metrics.ts';
import { listSnapshots } from '../../src/db/metrics.ts';
import { HOUR_MS } from '../../src/domain/time.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerId = (await createTestOwner()).id;
});

test('経過時間からバケットを選ぶ', { skip: false }, () => {
  assert.equal(bucketForElapsed(30 * 60_000), null);
  assert.equal(bucketForElapsed(1 * HOUR_MS), 1);
  assert.equal(bucketForElapsed(23 * HOUR_MS), 1);
  assert.equal(bucketForElapsed(24 * HOUR_MS), 24);
  assert.equal(bucketForElapsed(100 * HOUR_MS), 72);
  assert.equal(bucketForElapsed(1000 * HOUR_MS), 168);
});

test('次のバケットまでの待ち時間', { skip: false }, () => {
  assert.equal(nextBucketDelayMs(0), 1 * HOUR_MS);
  assert.equal(nextBucketDelayMs(1 * HOUR_MS), 23 * HOUR_MS);
  assert.equal(nextBucketDelayMs(200 * HOUR_MS), null);
});

async function publishedVariant(elapsedHours: number): Promise<string> {
  const post = await createPost({
    ownerId, title: 'm', category: 'general_tips', ctaKind: 'none', ctaUrl: null,
    variants: [{ platform: 'x', body: '指標テストの本文です。' }],
  });
  const variantId = post.ok ? post.variants[0].id : '';
  await query(
    `UPDATE post_variants
        SET state = 'PUBLISHED', external_post_id = $2, published_at = now() - ($3 || ' hours')::interval
      WHERE id = $1`,
    [variantId, `ext-${variantId.slice(0, 8)}`, String(elapsedHours)],
  );
  await enqueueJob({ ownerId, kind: 'collect_metrics', refId: variantId });
  return variantId;
}

function metricsFactory(
  values: Partial<Record<'impressions' | 'likes' | 'replies' | 'reposts' | 'linkClicks', number | null>>,
  mode: 'live' | 'simulated' | 'disconnected' = 'live',
) {
  let calls = 0;
  const adapter: MetricsAdapter = {
    platform: 'x',
    mode: mode === 'disconnected' ? 'simulated' : mode,
    async fetchMetrics() {
      calls += 1;
      return {
        ok: true,
        raw: { stub: true },
        values: {
          impressions: null, likes: null, replies: null, reposts: null, linkClicks: null, ...values,
        },
      };
    },
  };
  const factory: MetricsAdapterFactory = async () => ({ adapter, mode });
  return { factory, getCalls: () => calls };
}

test('指標を取得してスナップショットに残す', options, async () => {
  const variantId = await publishedVariant(25);
  const { factory } = metricsFactory({ impressions: 120, likes: 5, replies: 1, reposts: 0 });

  const result = await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });
  assert.equal(result.kind, 'captured');
  assert.equal(result.kind === 'captured' && result.bucketHours, 24);

  const snapshots = await listSnapshots(ownerId);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].values.impressions, 120);
  assert.equal(snapshots[0].values.likes, 5);
});

test('取得できない指標は NULL のまま保存する', options, async () => {
  await publishedVariant(25);
  const { factory } = metricsFactory({ likes: 5 }); // 表示数は取得できない

  await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });
  const rows = await query<{ impressions: number | null; likes: number | null }>(
    `SELECT impressions, likes FROM metric_snapshots WHERE owner_id = $1`, [ownerId],
  );
  assert.equal(rows[0].impressions, null, '0で埋めてはいけない');
  assert.equal(rows[0].likes, 5);
});

test('クリック数は媒体ではなく内部の記録から数える', options, async () => {
  const variantId = await publishedVariant(25);
  for (const clickId of ['c1', 'c2', 'c3']) {
    await query(
      `INSERT INTO click_events (owner_id, click_id, variant_id) VALUES ($1, $2, $3)`,
      [ownerId, clickId, variantId],
    );
  }
  const { factory } = metricsFactory({ likes: 1 });
  await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });

  const rows = await query<{ link_clicks: number }>(
    `SELECT link_clicks FROM metric_snapshots WHERE variant_id = $1`, [variantId],
  );
  assert.equal(rows[0].link_clicks, 3);
});

test('最初のバケットに達していなければ取得しない', options, async () => {
  await publishedVariant(0);
  const { factory, getCalls } = metricsFactory({ likes: 1 });
  const result = await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });
  assert.equal(result.kind === 'skipped' && result.reason, 'too early');
  assert.equal(getCalls(), 0);
  assert.equal((await listSnapshots(ownerId)).length, 0);
});

test('未接続では取得しない', options, async () => {
  await publishedVariant(25);
  const { factory, getCalls } = metricsFactory({ likes: 1 }, 'disconnected');
  const result = await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });
  assert.equal(result.kind === 'skipped' && result.reason, 'disconnected');
  assert.equal(getCalls(), 0);
});

test('公開済みでなければ取得しない', options, async () => {
  const post = await createPost({
    ownerId, title: 'm', category: 'general_tips', ctaKind: 'none', ctaUrl: null,
    variants: [{ platform: 'x', body: '下書きのままの本文です。' }],
  });
  const variantId = post.ok ? post.variants[0].id : '';
  await enqueueJob({ ownerId, kind: 'collect_metrics', refId: variantId });

  const { factory, getCalls } = metricsFactory({ likes: 1 });
  const result = await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });
  assert.equal(result.kind === 'skipped' && result.reason, 'not published');
  assert.equal(getCalls(), 0);
});

test('未完了の取得ジョブがあれば二重に積まれない', options, async () => {
  const variantId = await publishedVariant(25);
  const { factory } = metricsFactory({ likes: 5 });
  await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });

  // 次バケットの取得がすでに予約されているので、追加で積んでも増えない。
  const duplicate = await enqueueJob({ ownerId, kind: 'collect_metrics', refId: variantId });
  assert.equal(duplicate, null);
  const jobs = await query(
    `SELECT 1 FROM jobs WHERE kind = 'collect_metrics' AND ref_id = $1 AND state = 'READY'`, [variantId],
  );
  assert.equal(jobs.length, 1);
});

test('同じバケットで再取得したら行を増やさず値を更新する', options, async () => {
  const variantId = await publishedVariant(25);
  const { factory } = metricsFactory({ likes: 5 });
  await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });

  // 予約済みの次バケット取得が動く番になったが、経過時間はまだ24hバケットのまま。
  await query(
    `UPDATE jobs SET run_after = now() - interval '1 minute'
      WHERE kind = 'collect_metrics' AND ref_id = $1 AND state = 'READY'`, [variantId],
  );
  const { factory: second } = metricsFactory({ likes: 9 });
  const result = await processOneMetricsJob({ workerId: 'w1', adapterFactory: second });
  assert.equal(result.kind === 'captured' && result.bucketHours, 24);

  const rows = await query<{ likes: number }>(
    `SELECT likes FROM metric_snapshots WHERE variant_id = $1`, [variantId],
  );
  assert.equal(rows.length, 1, 'バケットごとに1行');
  assert.equal(rows[0].likes, 9, '新しい値で更新される');
});

test('取得後に次のバケットが予約される', options, async () => {
  const variantId = await publishedVariant(25);
  const { factory } = metricsFactory({ likes: 1 });
  await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });

  const jobs = await query<{ state: string; run_after: Date }>(
    `SELECT state, run_after FROM jobs WHERE kind = 'collect_metrics' AND ref_id = $1 AND state = 'READY'`,
    [variantId],
  );
  assert.equal(jobs.length, 1, '72時間後の取得が予約される');
  assert.ok(jobs[0].run_after.getTime() > Date.now());
});

test('最後のバケットまで終われば予約しない', options, async () => {
  const variantId = await publishedVariant(200);
  const { factory } = metricsFactory({ likes: 1 });
  const result = await processOneMetricsJob({ workerId: 'w1', adapterFactory: factory });
  assert.equal(result.kind === 'captured' && result.bucketHours, 168);
  const jobs = await query(
    `SELECT 1 FROM jobs WHERE kind = 'collect_metrics' AND ref_id = $1 AND state = 'READY'`, [variantId],
  );
  assert.equal(jobs.length, 0);
});

test('取得に失敗したら時間をおいて再試行する', options, async () => {
  const variantId = await publishedVariant(25);
  const adapter: MetricsAdapter = {
    platform: 'x', mode: 'live',
    async fetchMetrics() { return { ok: false, reason: '取得できませんでした' }; },
  };
  const result = await processOneMetricsJob({
    workerId: 'w1', adapterFactory: async () => ({ adapter, mode: 'live' }),
  });
  assert.equal(result.kind, 'skipped');
  assert.equal((await listSnapshots(ownerId)).length, 0, '失敗を0として記録しない');

  const jobs = await query<{ state: string; run_after: Date }>(
    `SELECT state, run_after FROM jobs WHERE ref_id = $1`, [variantId],
  );
  assert.equal(jobs[0].state, 'READY');
  assert.ok(jobs[0].run_after.getTime() > Date.now());
});
