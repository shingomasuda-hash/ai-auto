import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, getPool, dbAvailable } from './helpers.ts';
import { enqueueJob, claimJob, finishJob, sweepExpiredClaims, countJobs } from '../../src/db/jobs.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerId = (await createTestOwner()).id;
});

async function makeVariant(state = 'SCHEDULED', platform = 'x'): Promise<string> {
  const posts = await query<{ id: string }>(
    `INSERT INTO posts (owner_id, category) VALUES ($1, 'general_tips') RETURNING id`,
    [ownerId],
  );
  const variants = await query<{ id: string }>(
    `INSERT INTO post_variants (owner_id, post_id, platform, body, state, scheduled_at)
     VALUES ($1, $2, $3, '本文', $4, now())
     RETURNING id`,
    [ownerId, posts[0].id, platform, state],
  );
  return variants[0].id;
}

test('同じ対象の未完了ジョブは二重に積まれない', options, async () => {
  const variantId = await makeVariant();
  const first = await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  const second = await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  assert.notEqual(first, null);
  assert.equal(second, null);
  assert.equal(await countJobs(ownerId, 'READY'), 1);
});

test('完了後は同じ対象で再度積める', options, async () => {
  const variantId = await makeVariant();
  const job = await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  await finishJob(job!.id, 'DONE');
  const again = await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  assert.notEqual(again, null);
});

test('並行するワーカーが同じジョブを二重に取得しない', options, async () => {
  const jobCount = 12;
  const workerCount = 8;
  for (let i = 0; i < jobCount; i += 1) {
    const variantId = await makeVariant();
    await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  }

  // 各ワーカーが取れるだけ取る、を同時に走らせる。
  const claimAll = async (workerId: string) => {
    const claimed: string[] = [];
    for (;;) {
      const job = await claimJob(workerId);
      if (!job) break;
      claimed.push(job.id);
    }
    return claimed;
  };

  const results = await Promise.all(
    Array.from({ length: workerCount }, (_, i) => claimAll(`worker-${i}`)),
  );

  const all = results.flat();
  assert.equal(all.length, jobCount, '取得できた総数が積んだ数と一致する');
  assert.equal(new Set(all).size, jobCount, '同じジョブが二度取得されていない');
  assert.equal(await countJobs(ownerId, 'CLAIMED'), jobCount);
  assert.equal(await countJobs(ownerId, 'READY'), 0);
});

test('claim には必ず期限が付く', options, async () => {
  const variantId = await makeVariant();
  await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  const job = await claimJob('w1', { leaseMs: 60_000 });
  assert.notEqual(job, null);
  assert.notEqual(job!.claim_expires_at, null);
  assert.equal(job!.claimed_by, 'w1');
  assert.equal(job!.attempts, 1);
  const lease = job!.claim_expires_at!.getTime() - job!.claimed_at!.getTime();
  assert.ok(Math.abs(lease - 60_000) < 2000, `lease=${lease}`);
});

test('実行時刻前のジョブは取得しない', options, async () => {
  const variantId = await makeVariant();
  await enqueueJob({ ownerId, kind: 'publish', refId: variantId, runAfter: new Date(Date.now() + 3600_000) });
  assert.equal(await claimJob('w1'), null);
});

test('種別で絞って取得できる', options, async () => {
  const v1 = await makeVariant();
  const v2 = await makeVariant();
  await enqueueJob({ ownerId, kind: 'publish', refId: v1 });
  await enqueueJob({ ownerId, kind: 'collect_metrics', refId: v2 });
  const job = await claimJob('w1', { kinds: ['collect_metrics'] });
  assert.equal(job?.kind, 'collect_metrics');
});

test('送信開始前に期限切れした claim は安全に戻す', options, async () => {
  const variantId = await makeVariant('SCHEDULED');
  await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  const job = await claimJob('w1', { leaseMs: 1 });
  // ワーカーは CLAIMED にしたが送信は始めていない
  await query(`UPDATE post_variants SET state = 'CLAIMED' WHERE id = $1`, [variantId]);
  await query(`UPDATE jobs SET claim_expires_at = now() - interval '1 minute' WHERE id = $1`, [job!.id]);

  const result = await sweepExpiredClaims();
  assert.deepEqual(result.quarantined, []);
  assert.deepEqual(result.released, [job!.id]);

  const variant = await query<{ state: string }>(`SELECT state FROM post_variants WHERE id = $1`, [variantId]);
  assert.equal(variant[0].state, 'SCHEDULED', '外部未送信なので予約へ戻る');
  assert.equal(await countJobs(ownerId, 'READY'), 1);
});

test('送信中に期限切れした処理は UNKNOWN へ隔離し、再送しない', options, async () => {
  const variantId = await makeVariant('SCHEDULED');
  await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  const job = await claimJob('w1', { leaseMs: 1 });
  // 送信を開始した状態でワーカーが落ちた
  await query(`UPDATE post_variants SET state = 'PUBLISHING' WHERE id = $1`, [variantId]);
  await query(`UPDATE jobs SET claim_expires_at = now() - interval '1 minute' WHERE id = $1`, [job!.id]);

  const result = await sweepExpiredClaims();
  assert.deepEqual(result.released, []);
  assert.deepEqual(result.quarantined, [{ jobId: job!.id, variantId }]);

  const variant = await query<{ state: string }>(`SELECT state FROM post_variants WHERE id = $1`, [variantId]);
  assert.equal(variant[0].state, 'UNKNOWN');

  // publish ジョブは再実行されない
  const publishJobs = await query<{ state: string }>(
    `SELECT state FROM jobs WHERE kind = 'publish' AND ref_id = $1`, [variantId],
  );
  assert.equal(publishJobs[0].state, 'FAILED');
  assert.equal(await claimJob('w2', { kinds: ['publish'] }), null, '再送のために取得できてはいけない');

  // 代わりに外部の公開状態を照合するジョブが積まれる
  const reconcile = await query<{ state: string }>(
    `SELECT state FROM jobs WHERE kind = 'reconcile' AND ref_id = $1`, [variantId],
  );
  assert.equal(reconcile.length, 1);
  assert.equal(reconcile[0].state, 'READY');
});

test('期限内の claim は回収しない', options, async () => {
  const variantId = await makeVariant();
  await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  await claimJob('w1', { leaseMs: 600_000 });
  const result = await sweepExpiredClaims();
  assert.deepEqual(result.released, []);
  assert.deepEqual(result.quarantined, []);
  assert.equal(await countJobs(ownerId, 'CLAIMED'), 1);
});

test('決着済みの variant のジョブは閉じる', options, async () => {
  const variantId = await makeVariant();
  await enqueueJob({ ownerId, kind: 'publish', refId: variantId });
  const job = await claimJob('w1', { leaseMs: 1 });
  await query(
    `UPDATE post_variants SET state = 'PUBLISHED', external_post_id = 'ext-1', published_at = now() WHERE id = $1`,
    [variantId],
  );
  await query(`UPDATE jobs SET claim_expires_at = now() - interval '1 minute' WHERE id = $1`, [job!.id]);
  await sweepExpiredClaims();
  const jobs = await query<{ state: string }>(`SELECT state FROM jobs WHERE id = $1`, [job!.id]);
  assert.equal(jobs[0].state, 'DONE');
});

test('1件のジョブを多数のワーカーが同時に狙っても取得できるのは1人だけ', options, async () => {
  const variantId = await makeVariant();
  await enqueueJob({ ownerId, kind: 'publish', refId: variantId });

  // 同時に走らせる。SKIP LOCKED により、勝者以外は待たずに null を得る。
  const attempts = await Promise.all(
    Array.from({ length: 16 }, (_, i) => claimJob(`racer-${i}`)),
  );

  const winners = attempts.filter((job) => job !== null);
  assert.equal(winners.length, 1, `勝者は1人のはずが ${winners.length} 人`);
  assert.equal(await countJobs(ownerId, 'CLAIMED'), 1);
  assert.equal(await countJobs(ownerId, 'READY'), 0);
  // attempts が1回だけ増えている(敗者がカウンタを進めていない)
  const rows = await query<{ attempts: number }>(`SELECT attempts FROM jobs WHERE ref_id = $1`, [variantId]);
  assert.equal(rows[0].attempts, 1);
});

test('複数ラウンドの競合でも取りこぼしと重複がない', options, async () => {
  const jobCount = 30;
  for (let i = 0; i < jobCount; i += 1) {
    await enqueueJob({ ownerId, kind: 'publish', refId: await makeVariant() });
  }
  // 20並列で一斉に1件ずつ取りに行くのを、全部なくなるまで繰り返す。
  const claimed: string[] = [];
  for (;;) {
    const round = await Promise.all(Array.from({ length: 20 }, (_, i) => claimJob(`w${i}`)));
    const got = round.filter((j) => j !== null).map((j) => j!.id);
    if (got.length === 0) break;
    claimed.push(...got);
  }
  assert.equal(claimed.length, jobCount);
  assert.equal(new Set(claimed).size, jobCount);
});
