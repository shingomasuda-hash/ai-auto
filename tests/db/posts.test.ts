import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import {
  createPost, updateVariantBody, approveVariant, scheduleVariant,
  cancelSchedule, revertToDraft, expireOverdue, transitionByWorker,
  getVariant, listVariants,
} from '../../src/db/posts.ts';
import { fromJstParts, toJstParts } from '../../src/domain/time.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerId = '';
let otherId = '';

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerId = (await createTestOwner()).id;
  otherId = (await createTestOwner()).id;
});

const future = (hours: number) => new Date(Date.now() + hours * 3600_000);

async function newVariant(body = '意図整理の考え方についての本文です。', platform: 'threads' | 'x' = 'threads') {
  const result = await createPost({
    ownerId,
    title: 'テスト',
    category: 'intent_organizing',
    ctaKind: 'none',
    ctaUrl: null,
    variants: [{ platform, body }],
  });
  assert.equal(result.ok, true);
  return result.ok ? result.variants[0] : (() => { throw new Error('unreachable'); })();
}

test('作成直後は DRAFT', options, async () => {
  const variant = await newVariant();
  assert.equal(variant.state, 'DRAFT');
  assert.equal(variant.approved_at, null);
});

test('媒体の上限を超える本文は作成できない', options, async () => {
  const result = await createPost({
    ownerId, title: 't', category: 'general_tips', ctaKind: 'none', ctaUrl: null,
    variants: [{ platform: 'x', body: 'あ'.repeat(200) }],
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.errors.length, 1);
});

test('CTAの種別とURLの整合を強制する', options, async () => {
  const noUrl = await createPost({
    ownerId, title: 't', category: 'general_tips', ctaKind: 'free_material', ctaUrl: null,
    variants: [{ platform: 'x', body: '本文' }],
  });
  assert.equal(noUrl.ok, false);
});

test('ThreadsとX向けは別の下書きとして持てる', options, async () => {
  const result = await createPost({
    ownerId, title: 't', category: 'general_tips', ctaKind: 'none', ctaUrl: null,
    variants: [
      { platform: 'threads', body: 'Threads向けの長めの本文です。' },
      { platform: 'x', body: 'X向けの短い本文。' },
    ],
  });
  assert.equal(result.ok && result.variants.length, 2);
  assert.equal(result.ok && result.variants[0].body !== result.variants[1].body, true);
  // それぞれ独立に状態を持つ
  const list = await listVariants(ownerId);
  assert.equal(list.length, 2);
});

test('承認→予約の順でしか予約できない', options, async () => {
  const variant = await newVariant();
  const tooEarly = await scheduleVariant(ownerId, variant.id, future(3));
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.ok === false ? tooEarly.errors[0] : '', /not allowed/);

  await approveVariant(ownerId, variant.id);
  const scheduled = await scheduleVariant(ownerId, variant.id, future(3));
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.ok && scheduled.variant.state, 'SCHEDULED');
});

test('予約すると publish ジョブが積まれる', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  await scheduleVariant(ownerId, variant.id, future(3));
  const jobs = await query<{ state: string; run_after: Date }>(
    `SELECT state, run_after FROM jobs WHERE kind = 'publish' AND ref_id = $1`, [variant.id],
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'READY');
});

test('承認後に本文を変えると再承認が必要になり、予約も外れる', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  await scheduleVariant(ownerId, variant.id, future(3));

  const updated = await updateVariantBody(ownerId, variant.id, '本文を書き換えました。');
  assert.equal(updated.ok, true);
  assert.equal(updated.ok && updated.reapprovalRequired, true);
  assert.equal(updated.ok && updated.variant.state, 'DRAFT');
  assert.equal(updated.ok && updated.variant.approved_at, null);
  assert.equal(updated.ok && updated.variant.scheduled_at, null);

  // 予約ジョブも取り消されている
  const jobs = await query<{ state: string }>(
    `SELECT state FROM jobs WHERE kind = 'publish' AND ref_id = $1`, [variant.id],
  );
  assert.equal(jobs[0].state, 'CANCELLED');
});

test('内容が同じなら再承認は不要', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  const updated = await updateVariantBody(ownerId, variant.id, variant.body);
  assert.equal(updated.ok && updated.reapprovalRequired, false);
  assert.equal(updated.ok && updated.variant.state, 'APPROVED');
});

test('承認済みハッシュと本文が食い違えば予約させない', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  // 承認ハッシュを迂回して直接本文を書き換えた場合でも予約を止める
  await query(`UPDATE post_variants SET body = '直接書き換え' WHERE id = $1`, [variant.id]);
  const result = await scheduleVariant(ownerId, variant.id, future(3));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.errors[0] : '', /再承認/);
});

test('1日3件・2時間間隔の運営上限を予約時に適用する', options, async () => {
  // JSTの同じ暦日に収まる時刻を明示的に選ぶ(9時/12時/15時/18時)。
  const target = toJstParts(future(48));
  const slot = (hour: number) => fromJstParts({ ...target, hour, minute: 0 });

  for (const [i, hour] of [9, 12, 15].entries()) {
    const v = await newVariant(`本文バリエーション ${i} 番目です。`, 'x');
    await approveVariant(ownerId, v.id);
    const result = await scheduleVariant(ownerId, v.id, slot(hour));
    assert.equal(result.ok, true, `${i}件目: ${result.ok ? '' : result.errors.join('/')}`);
  }

  const fourth = await newVariant('4件目の本文です。', 'x');
  await approveVariant(ownerId, fourth.id);
  const rejected = await scheduleVariant(ownerId, fourth.id, slot(18));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false && rejected.violations?.some((v) => v.code === 'daily_limit'), true);

  // 翌JST日ならまた3件まで積める
  const nextDay = await newVariant('翌日の本文です。', 'x');
  await approveVariant(ownerId, nextDay.id);
  const nextDayResult = await scheduleVariant(
    ownerId, nextDay.id, new Date(slot(9).getTime() + 24 * 3600_000),
  );
  assert.equal(nextDayResult.ok, true);
});

test('同一媒体で2時間以内の予約を弾く', options, async () => {
  const first = await newVariant('最初の本文です。', 'x');
  await approveVariant(ownerId, first.id);
  await scheduleVariant(ownerId, first.id, future(24));

  const second = await newVariant('二つ目の本文です。', 'x');
  await approveVariant(ownerId, second.id);
  const result = await scheduleVariant(ownerId, second.id, future(25));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.violations?.some((v) => v.code === 'min_interval'), true);
});

test('同じ内容の重複を警告し、明示的な許可で通す', options, async () => {
  const body = 'まったく同じ内容の本文です。';
  const first = await newVariant(body, 'x');
  await approveVariant(ownerId, first.id);
  await scheduleVariant(ownerId, first.id, future(24));

  const second = await newVariant(body, 'x');
  await approveVariant(ownerId, second.id);
  const blocked = await scheduleVariant(ownerId, second.id, future(30));
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok === false ? blocked.errors[0] : '', /同じ内容/);

  const allowed = await scheduleVariant(ownerId, second.id, future(30), { allowDuplicate: true });
  assert.equal(allowed.ok, true);
});

test('予約を取り消せる', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  await scheduleVariant(ownerId, variant.id, future(3));
  const cancelled = await cancelSchedule(ownerId, variant.id);
  assert.equal(cancelled.ok && cancelled.variant.state, 'APPROVED');
  assert.equal(cancelled.ok && cancelled.variant.scheduled_at, null);
  const jobs = await query<{ state: string }>(`SELECT state FROM jobs WHERE ref_id = $1`, [variant.id]);
  assert.equal(jobs[0].state, 'CANCELLED');
});

test('下書きへ戻せる', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  const reverted = await revertToDraft(ownerId, variant.id);
  assert.equal(reverted.ok && reverted.variant.state, 'DRAFT');
});

test('期限切れの予約は EXPIRED になり、一斉投稿されない', options, async () => {
  const stale = await newVariant('古い予約の本文です。', 'x');
  const fresh = await newVariant('新しい予約の本文です。', 'threads');
  for (const v of [stale, fresh]) await approveVariant(ownerId, v.id);
  await scheduleVariant(ownerId, stale.id, future(1));
  await scheduleVariant(ownerId, fresh.id, future(1));
  // stale だけ25時間前に予約されていたことにする
  await query(`UPDATE post_variants SET scheduled_at = now() - interval '25 hours' WHERE id = $1`, [stale.id]);

  const expired = await expireOverdue();
  assert.deepEqual(expired, [stale.id]);

  const staleAfter = await getVariant(ownerId, stale.id);
  const freshAfter = await getVariant(ownerId, fresh.id);
  assert.equal(staleAfter?.state, 'EXPIRED');
  assert.equal(freshAfter?.state, 'SCHEDULED', '期限内の予約は巻き込まれない');

  const jobs = await query<{ state: string }>(`SELECT state FROM jobs WHERE ref_id = $1`, [stale.id]);
  assert.equal(jobs[0].state, 'CANCELLED', '期限切れ分は送信されない');
});

test('公開済みには外部IDと公開日時が必ず入る', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  await scheduleVariant(ownerId, variant.id, future(1));
  await transitionByWorker(ownerId, variant.id, 'CLAIMED');
  await transitionByWorker(ownerId, variant.id, 'PUBLISHING');
  const published = await transitionByWorker(ownerId, variant.id, 'PUBLISHED', { external_post_id: 'ext-1' });
  assert.equal(published.ok, true);
  assert.equal(published.ok && published.variant.external_post_id, 'ext-1');
  assert.notEqual(published.ok && published.variant.published_at, null);
});

test('外部IDなしでは PUBLISHED にできない(DB制約)', options, async () => {
  const variant = await newVariant();
  await assert.rejects(
    () => query(`UPDATE post_variants SET state = 'PUBLISHED' WHERE id = $1`, [variant.id]),
    /variants_published_requires_external/,
  );
});

test('同じ媒体で同じ外部投稿IDを二重に記録できない', options, async () => {
  const a = await newVariant('本文A です。', 'x');
  const b = await newVariant('本文B です。', 'x');
  await query(
    `UPDATE post_variants SET state='PUBLISHED', external_post_id='dup', published_at=now() WHERE id=$1`, [a.id],
  );
  await assert.rejects(
    () => query(
      `UPDATE post_variants SET state='PUBLISHED', external_post_id='dup', published_at=now() WHERE id=$1`, [b.id],
    ),
    /variants_external_id_key/,
  );
});

test('他人の投稿は読めない・変更できない', options, async () => {
  const variant = await newVariant();
  assert.equal(await getVariant(otherId, variant.id), null);
  assert.equal((await approveVariant(otherId, variant.id)).ok, false);
  assert.equal((await updateVariantBody(otherId, variant.id, '乗っ取り')).ok, false);
  assert.equal((await cancelSchedule(otherId, variant.id)).ok, false);
  assert.deepEqual(await listVariants(otherId), []);
  // 元の投稿は変わっていない
  const untouched = await getVariant(ownerId, variant.id);
  assert.equal(untouched?.body, variant.body);
  assert.equal(untouched?.state, 'DRAFT');
});

test('送信中の投稿は編集できない', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  await scheduleVariant(ownerId, variant.id, future(1));
  await transitionByWorker(ownerId, variant.id, 'CLAIMED');
  await transitionByWorker(ownerId, variant.id, 'PUBLISHING');
  const result = await updateVariantBody(ownerId, variant.id, '書き換え');
  assert.equal(result.ok, false);
});

test('UNKNOWN は照合でのみ確定し、再送できない', options, async () => {
  const variant = await newVariant();
  await approveVariant(ownerId, variant.id);
  await scheduleVariant(ownerId, variant.id, future(1));
  await transitionByWorker(ownerId, variant.id, 'CLAIMED');
  await transitionByWorker(ownerId, variant.id, 'PUBLISHING');
  await transitionByWorker(ownerId, variant.id, 'UNKNOWN', { last_error: 'timeout' });

  // 送信側へは戻せない
  assert.equal((await transitionByWorker(ownerId, variant.id, 'PUBLISHING')).ok, false);
  assert.equal((await transitionByWorker(ownerId, variant.id, 'CLAIMED')).ok, false);
  // 照合の結果としてのみ確定する
  const reconciled = await transitionByWorker(
    ownerId, variant.id, 'PUBLISHED', { external_post_id: 'found-1' }, 'reconciler',
  );
  assert.equal(reconciled.ok, true);
});
