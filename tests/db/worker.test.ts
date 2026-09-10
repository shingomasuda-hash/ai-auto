import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { createPost, approveVariant, scheduleVariant, getVariant } from '../../src/db/posts.ts';
import { updateSettings, setConnectionMode } from '../../src/db/settings.ts';
import { processOnePublishJob, processOneReconcileJob } from '../../src/worker/publish.ts';
import type { AdapterFactory } from '../../src/worker/publish.ts';
import type { PublishAdapter, PublishOutcome, ReconcileOutcome } from '../../src/adapters/types.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerId = (await createTestOwner()).id;
  // 既定は全停止。テストごとに必要なぶんだけ解除する。
  await updateSettings(ownerId, { global_stop: false, threads_stop: false, x_stop: false });
  await setConnectionMode(ownerId, 'threads', 'simulated');
  await setConnectionMode(ownerId, 'x', 'simulated');
});

/** 送信回数を数え、結果を差し替えられるアダプター。 */
function fakeAdapter(outcome: PublishOutcome, reconcile?: ReconcileOutcome) {
  const calls: { body: string; idempotencyKey: string }[] = [];
  const reconcileCalls: string[] = [];
  const adapter: PublishAdapter = {
    platform: 'x',
    mode: 'simulated',
    async publish(request) {
      calls.push({ body: request.body, idempotencyKey: request.idempotencyKey });
      return outcome;
    },
    async reconcile(request) {
      reconcileCalls.push(request.idempotencyKey);
      return reconcile ?? { indeterminate: true, detail: 'not configured' };
    },
  };
  const factory: AdapterFactory = async () => ({ adapter, mode: 'simulated' });
  return { factory, calls, reconcileCalls };
}

async function scheduledVariant(body = 'ワーカーのテスト本文です。', platform: 'x' | 'threads' = 'x') {
  const post = await createPost({
    ownerId, title: 'w', category: 'general_tips', ctaKind: 'none', ctaUrl: null,
    variants: [{ platform, body }],
  });
  assert.equal(post.ok, true);
  const variant = post.ok ? post.variants[0] : null;
  await approveVariant(ownerId, variant!.id);
  const scheduled = await scheduleVariant(ownerId, variant!.id, new Date(Date.now() + 3600_000));
  assert.equal(scheduled.ok, true);
  // 予約時刻を過ぎたことにして、ワーカーが拾えるようにする
  await query(
    `UPDATE post_variants SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [variant!.id],
  );
  await query(`UPDATE jobs SET run_after = now() - interval '1 minute' WHERE ref_id = $1`, [variant!.id]);
  return variant!.id;
}

test('公開に成功すると外部IDが記録され、attempt が残る', options, async () => {
  const variantId = await scheduledVariant();
  const fake = fakeAdapter({ outcome: 'PUBLISHED', externalPostId: 'ext-123', providerState: {} });

  const result = await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind, 'published');

  const variant = await getVariant(ownerId, variantId);
  assert.equal(variant?.state, 'PUBLISHED');
  assert.equal(variant?.external_post_id, 'ext-123');
  assert.notEqual(variant?.published_at, null);

  const attempts = await query<{ outcome: string; sent_to_provider: boolean; finished_at: Date }>(
    `SELECT outcome, sent_to_provider, finished_at FROM publish_attempts WHERE variant_id = $1`, [variantId],
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'PUBLISHED');
  assert.equal(attempts[0].sent_to_provider, true);
});

test('送信の前に attempt が永続化される', options, async () => {
  const variantId = await scheduledVariant();
  let attemptsAtSendTime = -1;
  let stateAtSendTime = '';
  const adapter: PublishAdapter = {
    platform: 'x', mode: 'simulated',
    async publish() {
      // 送信の瞬間にDBを覗く
      const rows = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM publish_attempts WHERE variant_id = $1`, [variantId],
      );
      attemptsAtSendTime = Number(rows[0].count);
      const variant = await query<{ state: string }>(
        `SELECT state FROM post_variants WHERE id = $1`, [variantId],
      );
      stateAtSendTime = variant[0].state;
      return { outcome: 'PUBLISHED', externalPostId: 'ext-1', providerState: {} };
    },
    async reconcile() { return { found: false }; },
  };

  await processOnePublishJob({ workerId: 'w1', adapterFactory: async () => ({ adapter, mode: 'simulated' }) });
  assert.equal(attemptsAtSendTime, 1, '送信時点で attempt が1件ある');
  assert.equal(stateAtSendTime, 'PUBLISHING', '送信時点で PUBLISHING になっている');
});

test('全体停止中は送信せず、予約へ戻す', options, async () => {
  const variantId = await scheduledVariant();
  await updateSettings(ownerId, { global_stop: true });
  const fake = fakeAdapter({ outcome: 'PUBLISHED', externalPostId: 'ext-1', providerState: {} });

  const result = await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind, 'skipped');
  assert.equal(result.kind === 'skipped' && result.reason, 'stopped');
  assert.equal(fake.calls.length, 0, '外部へ送信していない');

  const variant = await getVariant(ownerId, variantId);
  assert.equal(variant?.state, 'SCHEDULED', '予約へ戻る');
  const attempts = await query(`SELECT 1 FROM publish_attempts WHERE variant_id = $1`, [variantId]);
  assert.equal(attempts.length, 0, '送っていないので attempt も作らない');
});

test('媒体ごとの停止も送信直前に効く', options, async () => {
  await scheduledVariant('X向けの本文です。', 'x');
  await updateSettings(ownerId, { x_stop: true });
  const fake = fakeAdapter({ outcome: 'PUBLISHED', externalPostId: 'ext-1', providerState: {} });
  const result = await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind === 'skipped' && result.reason, 'stopped');
  assert.equal(fake.calls.length, 0);
});

test('未接続では送信しない', options, async () => {
  const variantId = await scheduledVariant();
  const adapter: PublishAdapter = {
    platform: 'x', mode: 'simulated',
    async publish() { throw new Error('送信されてはいけない'); },
    async reconcile() { return { found: false }; },
  };
  const result = await processOnePublishJob({
    workerId: 'w1',
    adapterFactory: async () => ({ adapter, mode: 'disconnected' }),
  });
  assert.equal(result.kind === 'skipped' && result.reason, 'not_connected');
  assert.equal((await getVariant(ownerId, variantId))?.state, 'SCHEDULED');
});

test('期限切れは送信せず EXPIRED にする', options, async () => {
  const variantId = await scheduledVariant();
  await query(`UPDATE post_variants SET scheduled_at = now() - interval '25 hours' WHERE id = $1`, [variantId]);
  const fake = fakeAdapter({ outcome: 'PUBLISHED', externalPostId: 'ext-1', providerState: {} });

  const result = await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind, 'skipped');
  assert.equal(fake.calls.length, 0);
  assert.equal((await getVariant(ownerId, variantId))?.state, 'EXPIRED');
});

test('明確な失敗は FAILED になり、再送されない', options, async () => {
  const variantId = await scheduledVariant();
  const fake = fakeAdapter({
    outcome: 'FAILED', errorCode: 'bad_request', detail: '本文が不正です',
    sentToProvider: true, providerState: {},
  });

  const result = await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind, 'failed');
  assert.equal((await getVariant(ownerId, variantId))?.state, 'FAILED');

  // ジョブは FAILED になり、次のワーカーが拾わない
  const second = await processOnePublishJob({ workerId: 'w2', adapterFactory: fake.factory });
  assert.equal(second.kind, 'idle');
  assert.equal(fake.calls.length, 1);
});

test('結果不明は UNKNOWN へ隔離し、絶対に再送しない', options, async () => {
  const variantId = await scheduledVariant();
  const fake = fakeAdapter({
    outcome: 'UNKNOWN', errorCode: 'timeout', detail: '応答がありませんでした', providerState: { sendRequested: true },
  });

  const result = await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind, 'unknown');
  assert.equal(fake.calls.length, 1);

  const variant = await getVariant(ownerId, variantId);
  assert.equal(variant?.state, 'UNKNOWN');
  assert.equal(variant?.external_post_id, null);

  // 何度ワーカーを回しても再送されない
  for (const worker of ['w2', 'w3', 'w4']) {
    assert.equal((await processOnePublishJob({ workerId: worker, adapterFactory: fake.factory })).kind, 'idle');
  }
  assert.equal(fake.calls.length, 1, '再送された');

  // attempt には「送った可能性がある」ことが残る
  const attempts = await query<{ outcome: string; sent_to_provider: boolean }>(
    `SELECT outcome, sent_to_provider FROM publish_attempts WHERE variant_id = $1`, [variantId],
  );
  assert.equal(attempts[0].outcome, 'UNKNOWN');
  assert.equal(attempts[0].sent_to_provider, true);

  // 代わりに照合ジョブが積まれる
  const reconcile = await query<{ state: string }>(
    `SELECT state FROM jobs WHERE kind = 'reconcile' AND ref_id = $1`, [variantId],
  );
  assert.equal(reconcile.length, 1);
});

test('アダプターが例外を投げても UNKNOWN として扱う', options, async () => {
  const variantId = await scheduledVariant();
  const adapter: PublishAdapter = {
    platform: 'x', mode: 'simulated',
    async publish() { throw new Error('接続が切れました'); },
    async reconcile() { return { indeterminate: true, detail: '' }; },
  };
  const result = await processOnePublishJob({
    workerId: 'w1', adapterFactory: async () => ({ adapter, mode: 'simulated' }),
  });
  assert.equal(result.kind, 'unknown');
  assert.equal((await getVariant(ownerId, variantId))?.state, 'UNKNOWN');
});

test('照合で公開済みと分かれば PUBLISHED に確定する', options, async () => {
  const variantId = await scheduledVariant();
  const fake = fakeAdapter(
    { outcome: 'UNKNOWN', errorCode: 'timeout', detail: '', providerState: {} },
    { found: true, externalPostId: 'found-999' },
  );
  await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });

  const result = await processOneReconcileJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind, 'published');

  const variant = await getVariant(ownerId, variantId);
  assert.equal(variant?.state, 'PUBLISHED');
  assert.equal(variant?.external_post_id, 'found-999');
  assert.equal(fake.calls.length, 1, '照合で再送してはいけない');
});

test('照合で存在しないと分かれば FAILED に確定する', options, async () => {
  const variantId = await scheduledVariant();
  const fake = fakeAdapter(
    { outcome: 'UNKNOWN', errorCode: 'timeout', detail: '', providerState: {} },
    { found: false },
  );
  await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  const result = await processOneReconcileJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind, 'failed');
  assert.equal((await getVariant(ownerId, variantId))?.state, 'FAILED');
});

test('照合できないうちは UNKNOWN のまま確定させない', options, async () => {
  const variantId = await scheduledVariant();
  const fake = fakeAdapter(
    { outcome: 'UNKNOWN', errorCode: 'timeout', detail: '', providerState: {} },
    { indeterminate: true, detail: '取得できませんでした' },
  );
  await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  const result = await processOneReconcileJob({ workerId: 'w1', adapterFactory: fake.factory });
  assert.equal(result.kind === 'skipped' && result.reason, 'indeterminate');
  assert.equal((await getVariant(ownerId, variantId))?.state, 'UNKNOWN', '勝手に確定させない');
});

test('並行するワーカーが同じ投稿を二重に送らない', options, async () => {
  const variantId = await scheduledVariant();
  let concurrent = 0;
  let maxConcurrent = 0;
  const calls: string[] = [];
  const adapter: PublishAdapter = {
    platform: 'x', mode: 'simulated',
    async publish(request) {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      calls.push(request.idempotencyKey);
      await new Promise((resolve) => setTimeout(resolve, 60));
      concurrent -= 1;
      return { outcome: 'PUBLISHED', externalPostId: 'ext-1', providerState: {} };
    },
    async reconcile() { return { found: false }; },
  };
  const factory: AdapterFactory = async () => ({ adapter, mode: 'simulated' });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => processOnePublishJob({ workerId: `w${i}`, adapterFactory: factory })),
  );

  assert.equal(calls.length, 1, `送信は1回のはずが ${calls.length} 回`);
  assert.equal(maxConcurrent, 1);
  assert.equal(results.filter((r) => r.kind === 'published').length, 1);
  assert.equal((await getVariant(ownerId, variantId))?.state, 'PUBLISHED');
  const attempts = await query(`SELECT 1 FROM publish_attempts WHERE variant_id = $1`, [variantId]);
  assert.equal(attempts.length, 1, 'attempt も1件だけ');
});

test('公開後に指標取得のジョブが積まれる', options, async () => {
  const variantId = await scheduledVariant();
  const fake = fakeAdapter({ outcome: 'PUBLISHED', externalPostId: 'ext-1', providerState: {} });
  await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory });
  const jobs = await query<{ state: string }>(
    `SELECT state FROM jobs WHERE kind = 'collect_metrics' AND ref_id = $1`, [variantId],
  );
  assert.equal(jobs.length, 1);
});

test('処理対象がなければ何もしない', options, async () => {
  const fake = fakeAdapter({ outcome: 'PUBLISHED', externalPostId: 'x', providerState: {} });
  assert.equal((await processOnePublishJob({ workerId: 'w1', adapterFactory: fake.factory })).kind, 'idle');
  assert.equal(fake.calls.length, 0);
});
