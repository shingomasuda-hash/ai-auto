/**
 * キット収録の実データ（90投稿・本人の知識3件）の取り込みを検証する。
 *
 * 特に「勝手に予約・公開しない」「本人の経験を増やさない」を確かめる。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { importPosts } from '../../scripts/import-posts.ts';
import { seed } from '../../scripts/seed.ts';
import { checkLength } from '../../src/domain/text-length.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

let ownerEmail = '';

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  ownerEmail = (await createTestOwner()).email;
});

const rawPosts = JSON.parse(readFileSync('content/threads-90-posts.json', 'utf8')) as {
  id: string; text: string; category: string; status: string; day: number; time: string;
}[];
const rawFacts = JSON.parse(readFileSync('content/operator-facts.json', 'utf8')) as {
  id: string; kind: string; approved: boolean; text: string;
}[];

test('元データ自体が前提を満たしている', { skip: false }, () => {
  assert.equal(rawPosts.length, 90);
  assert.equal(new Set(rawPosts.map((p) => p.id)).size, 90, 'IDが重複している');
  assert.equal(rawPosts.every((p) => p.status === 'DRAFT'), true, 'DRAFT 以外が混ざっている');
  for (const post of rawPosts) {
    assert.equal(checkLength('threads', post.text).ok, true, `${post.id} がThreadsの上限を超えている`);
  }
  // 本人の経験として使えるのは3件だけ（AGENTS.md の明示）
  assert.equal(rawFacts.length, 3);
  assert.equal(rawFacts.every((f) => f.kind === 'operator_experience' && f.approved === true), true);
});

test('90件が DRAFT として入り、予約日時は入らない', options, async () => {
  const summary = await importPosts(ownerEmail);
  assert.equal(summary.created, 90);
  assert.deepEqual(summary.failed, []);

  const rows = await query<{ state: string; scheduled_at: Date | null; published_at: Date | null }>(
    `SELECT state, scheduled_at, published_at FROM post_variants`,
  );
  assert.equal(rows.length, 90);
  assert.equal(rows.every((r) => r.state === 'DRAFT'), true, 'DRAFT 以外になっている');
  assert.equal(rows.every((r) => r.scheduled_at === null), true, '予約日時が入っている');
  assert.equal(rows.every((r) => r.published_at === null), true, '公開日時が入っている');
});

test('承認されないので、そのままでは送信対象にならない', options, async () => {
  await importPosts(ownerEmail);
  const approved = await query(
    `SELECT 1 FROM post_variants WHERE state <> 'DRAFT'`,
  );
  assert.equal(approved.length, 0);
  // 送信ジョブも積まれない
  const jobs = await query(`SELECT 1 FROM jobs WHERE kind = 'publish'`);
  assert.equal(jobs.length, 0);
});

test('時間帯は目安として残るが、予約ではない', options, async () => {
  await importPosts(ownerEmail);
  const rows = await query<{ suggested_slot: string | null }>(
    `SELECT suggested_slot FROM posts WHERE import_key LIKE 'threads-90:%'`,
  );
  assert.equal(rows.length, 90);
  assert.equal(rows.every((r) => r.suggested_slot !== null), true);
  assert.match(rows[0].suggested_slot!, /^D\d{2} \d{2}:\d{2}$/);
});

test('元のカテゴリを読み替えずに保持する', options, async () => {
  await importPosts(ownerEmail);
  const rows = await query<{ category: string; count: string }>(
    `SELECT category, count(*)::text AS count FROM posts GROUP BY category`,
  );
  const actual = Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]));
  const expected: Record<string, number> = {};
  for (const post of rawPosts) expected[post.category] = (expected[post.category] ?? 0) + 1;
  assert.deepEqual(actual, expected);
});

test('X向けの文面は作られない', options, async () => {
  await importPosts(ownerEmail);
  const rows = await query<{ platform: string }>(`SELECT DISTINCT platform FROM post_variants`);
  assert.deepEqual(rows.map((r) => r.platform), ['threads']);
});

test('二度実行しても増えない', options, async () => {
  await importPosts(ownerEmail);
  const second = await importPosts(ownerEmail);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 90);
  const rows = await query(`SELECT 1 FROM posts WHERE import_key IS NOT NULL`);
  assert.equal(rows.length, 90);
});

test('本人の知識は3件だけが APPROVED で入る', options, async () => {
  await seed(ownerEmail);
  const rows = await query<{ source_key: string; kind: string; state: string; body: string }>(
    `SELECT source_key, kind, state, body FROM knowledge ORDER BY source_key`,
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.every((r) => r.kind === 'operator_experience'), true);
  assert.equal(rows.every((r) => r.state === 'APPROVED'), true);
  // 本文は元データそのまま。要約も補完もしない。
  for (const fact of rawFacts) {
    const row = rows.find((r) => r.source_key === fact.id);
    assert.equal(row?.body, fact.text, `${fact.id} の本文が書き換わっている`);
  }
});

test('seed を二度実行しても知識が増えない', options, async () => {
  await seed(ownerEmail);
  await seed(ownerEmail);
  const rows = await query(`SELECT 1 FROM knowledge`);
  assert.equal(rows.length, 3);
});

test('販売ページが CTA の許可先として登録される', options, async () => {
  await seed(ownerEmail);
  const rows = await query<{ sales_page_url: string | null }>(`SELECT sales_page_url FROM settings`);
  assert.match(rows[0].sales_page_url ?? '', /^https:\/\//);
});
