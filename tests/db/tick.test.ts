/**
 * 1巡ぶんの処理の上限を検証する。
 *
 * サーバーレスでは実行時間の上限がある。途中で殺されると送信中の
 * 処理が UNKNOWN になり、人の手で照合する手間が増える。
 * 上限の手前で自分から戻ることを確かめる。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { createPost, approveVariant, scheduleVariant, getVariant } from '../../src/db/posts.ts';
import { updateSettings, setConnectionMode } from '../../src/db/settings.ts';
import { runTick, didWork } from '../../src/worker/tick.ts';
import type { AdapterFactory } from '../../src/worker/publish.ts';
import type { PublishAdapter } from '../../src/adapters/types.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerId = (await createTestOwner()).id;
  await updateSettings(ownerId, { global_stop: false, threads_stop: false, x_stop: false });
  await setConnectionMode(ownerId, 'threads', 'simulated');
});

/** 送信のたびに指定ミリ秒かかるアダプター。 */
function slowAdapter(delayMs: number) {
  let calls = 0;
  const adapter: PublishAdapter = {
    platform: 'threads', mode: 'simulated',
    async publish() {
      calls += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { outcome: 'PUBLISHED', externalPostId: `ext-${calls}`, providerState: {} };
    },
    async reconcile() { return { found: false }; },
  };
  const factory: AdapterFactory = async () => ({ adapter, mode: 'simulated' });
  return { factory, getCalls: () => calls };
}

/** 予約済みの投稿を n 件作り、送信可能な状態にする。 */
async function readyVariants(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const post = await createPost({
      ownerId, title: `t${i}`, category: 'general_tips', ctaKind: 'none', ctaUrl: null,
      variants: [{ platform: 'threads', body: `${i} 番目の本文です。上限の検証に使います。` }],
    });
    const id = post.ok ? post.variants[0].id : '';
    await approveVariant(ownerId, id);
    // 運営上限（24時間で3件・2時間間隔）を避けるため、予約は個別に通す
    await query(
      `UPDATE post_variants SET state = 'SCHEDULED', scheduled_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await query(
      `INSERT INTO jobs (owner_id, kind, ref_id, run_after) VALUES ($1, 'publish', $2, now() - interval '1 minute')`,
      [ownerId, id],
    );
    ids.push(id);
  }
  return ids;
}

test('処理対象が無ければ何もせず戻る', options, async () => {
  const { factory, getCalls } = slowAdapter(0);
  const summary = await runTick({ workerId: 'w1', budgetMs: 5000, maxJobs: 10, adapterFactory: factory });
  assert.equal(summary.processed, 0);
  assert.equal(getCalls(), 0);
  assert.equal(didWork(summary), false);
  assert.equal(summary.budgetExhausted, false);
});

test('件数の上限で止まり、残りは次回に回す', options, async () => {
  await readyVariants(10);
  const { factory, getCalls } = slowAdapter(0);

  const first = await runTick({ workerId: 'w1', budgetMs: 60_000, maxJobs: 3, adapterFactory: factory });
  assert.equal(first.processed, 3, '上限を超えてジョブに手を付けている');
  assert.equal(first.budgetExhausted, true, '残りがあることを示していない');

  const second = await runTick({ workerId: 'w1', budgetMs: 60_000, maxJobs: 3, adapterFactory: factory });
  assert.equal(second.processed, 3);
  // 送信は運営上限に阻まれるので、外部呼出しは処理件数より少ない
  assert.ok(getCalls() <= 2, `外部へ ${getCalls()} 回送信した`);
});

test('たまった予約を1巡で一斉送信しない（2時間間隔を守る）', options, async () => {
  // 90件の下書きを一度に承認したような状況でも、まとめて流れてはいけない。
  await readyVariants(8);
  const { factory, getCalls } = slowAdapter(0);

  const summary = await runTick({ workerId: 'w1', budgetMs: 60_000, maxJobs: 50, adapterFactory: factory });

  assert.equal(summary.published, 1, `1巡で ${summary.published} 件送信した`);
  assert.equal(getCalls(), 1, '外部へ複数回送信した');
  assert.ok(summary.skipped >= 1, '残りが上限で見送られていない');

  // 見送られた分は、窓が空く時刻まで待たされる
  const waiting = await query<{ run_after: Date }>(
    `SELECT run_after FROM jobs WHERE state = 'READY' AND kind = 'publish' ORDER BY run_after LIMIT 1`,
  );
  assert.ok(
    waiting[0].run_after.getTime() > Date.now() + 60 * 60_000,
    '次の送信が1時間以内に予定されている',
  );
});

test('時間の上限で止まる', options, async () => {
  await readyVariants(20);
  // 1件40msかかる状況で、予算を120msにする
  const { factory } = slowAdapter(40);

  const summary = await runTick({ workerId: 'w1', budgetMs: 120, maxJobs: 500, adapterFactory: factory });

  assert.ok(summary.processed >= 1, '1件も処理していない');
  assert.ok(summary.processed < 20, `上限を無視して ${summary.processed} 件処理した`);
  assert.equal(summary.budgetExhausted, true);
  // 実行中のジョブは切らないので多少は超過する。桁で超えていないことを見る。
  assert.ok(summary.durationMs < 2000, `所要 ${summary.durationMs}ms`);
});

test('途中で戻っても投稿の状態は壊れない', options, async () => {
  const ids = await readyVariants(5);
  const { factory } = slowAdapter(0);
  await runTick({ workerId: 'w1', budgetMs: 60_000, maxJobs: 2, adapterFactory: factory });

  const states = await Promise.all(ids.map((id) => getVariant(ownerId, id)));
  // 送信されたか、予約のまま。中途半端な状態は残らない。
  for (const variant of states) {
    assert.ok(
      variant?.state === 'PUBLISHED' || variant?.state === 'SCHEDULED',
      `中途半端な状態: ${variant?.state}`,
    );
  }
  assert.equal(states.filter((v) => v?.state === 'PUBLISHED').length, 1);

  // 送信していない分に attempt は作られていない
  const attempts = await query<{ count: string }>(`SELECT count(*)::text AS count FROM publish_attempts`);
  assert.equal(Number(attempts[0].count), 1);
});

test('停止中は送信せず、上限にも達しない', options, async () => {
  await readyVariants(5);
  await updateSettings(ownerId, { global_stop: true });
  const { factory, getCalls } = slowAdapter(0);

  const summary = await runTick({ workerId: 'w1', budgetMs: 60_000, maxJobs: 10, adapterFactory: factory });
  assert.equal(getCalls(), 0, '停止中に外部へ送信した');
  assert.equal(summary.published, 0);
  assert.ok(summary.skipped > 0, '停止として見送られていない');
});

test('期限切れの後片付けを送信より先に行う', options, async () => {
  const ids = await readyVariants(2);
  // 1件を25時間前の予約にする
  await query(
    `UPDATE post_variants SET scheduled_at = now() - interval '25 hours' WHERE id = $1`, [ids[0]],
  );
  const { factory, getCalls } = slowAdapter(0);

  const summary = await runTick({ workerId: 'w1', budgetMs: 60_000, maxJobs: 10, adapterFactory: factory });

  assert.deepEqual(summary.expired, [ids[0]]);
  assert.equal((await getVariant(ownerId, ids[0]))?.state, 'EXPIRED');
  assert.equal(getCalls(), 1, '期限切れのものまで送信している');
  assert.equal((await getVariant(ownerId, ids[1]))?.state, 'PUBLISHED');
});

test('中断の合図で新しいジョブに手を付けない', options, async () => {
  await readyVariants(5);
  const controller = new AbortController();
  controller.abort();
  const { factory, getCalls } = slowAdapter(0);

  const summary = await runTick({
    workerId: 'w1', budgetMs: 60_000, maxJobs: 10, adapterFactory: factory, signal: controller.signal,
  });
  assert.equal(getCalls(), 0);
  assert.equal(summary.processed, 0);
  assert.equal(summary.budgetExhausted, true);
});

test('並行して起動しても同じ投稿を二重に送らない', options, async () => {
  await readyVariants(6);
  const { factory, getCalls } = slowAdapter(20);

  // cron が重なった状況
  const results = await Promise.all([
    runTick({ workerId: 'cron-a', budgetMs: 60_000, maxJobs: 20, adapterFactory: factory }),
    runTick({ workerId: 'cron-b', budgetMs: 60_000, maxJobs: 20, adapterFactory: factory }),
  ]);

  const published = results.reduce((sum, r) => sum + r.published, 0);
  // 運営上限があるので送信できるのは1件。重なっても増えない。
  assert.equal(published, 1, `${published} 件送信された`);
  assert.equal(getCalls(), 1, '外部へ二重に送信している');

  const attempts = await query<{ count: string }>(`SELECT count(*)::text AS count FROM publish_attempts`);
  assert.equal(Number(attempts[0].count), 1, 'attempt が二重に作られている');

  // 同じ投稿が2回公開されていない
  const externalIds = await query<{ external_post_id: string }>(
    `SELECT external_post_id FROM post_variants WHERE external_post_id IS NOT NULL`,
  );
  assert.equal(new Set(externalIds.map((r) => r.external_post_id)).size, externalIds.length);
});
