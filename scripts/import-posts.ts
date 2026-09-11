/**
 * 既存の Threads 投稿を DRAFT として冪等に投入する。
 *
 * 読むのは content/threads-90-posts.json（キット収録の形式）:
 *   [{ id, day, time, category, topic, text, status }]
 *
 * 守ること:
 *  - 同じ id は二度入らない（posts.import_key で担保）。
 *  - **day / time を予約日時にしない。** これは元データが持っていた
 *    時間帯の目安であって、予約ではない。suggested_slot に文字列として
 *    残すだけで、scheduled_at は空のままにする。
 *  - 承認しない。状態は DRAFT のまま。
 *  - X向けの文面は作らない。X は別の下書きとして用意する。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { contentHash } from '../src/lib/crypto.ts';
import { normalizeForDuplicate } from '../src/domain/policy.ts';
import { checkLength } from '../src/domain/text-length.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'content/threads-90-posts.json';

type SeedPost = {
  id: string;
  day?: number;
  time?: string;
  category: string;
  topic?: string;
  text: string;
  status?: string;
};

export type ImportSummary = {
  created: number;
  skipped: number;
  failed: { id: string; errors: string[] }[];
};

export async function importPosts(ownerEmail?: string): Promise<ImportSummary> {
  const owners = await query<{ id: string }>(
    `SELECT id FROM users ${ownerEmail ? 'WHERE lower(email) = lower($1)' : ''} ORDER BY created_at LIMIT 1`,
    ownerEmail ? [ownerEmail] : [],
  );
  const owner = owners[0];
  if (!owner) throw new Error('所有者が見つかりません。先に admin:create を実行してください。');

  const posts = JSON.parse(await readFile(path.join(ROOT, SOURCE), 'utf8')) as SeedPost[];

  const existing = new Set(
    (await query<{ import_key: string }>(
      `SELECT import_key FROM posts WHERE owner_id = $1 AND import_key IS NOT NULL`,
      [owner.id],
    )).map((r) => r.import_key),
  );

  const summary: ImportSummary = { created: 0, skipped: 0, failed: [] };

  for (const post of posts) {
    const importKey = `threads-90:${post.id}`;
    if (existing.has(importKey)) {
      summary.skipped += 1;
      continue;
    }

    const errors: string[] = [];
    if (typeof post.text !== 'string' || post.text.trim() === '') errors.push('本文が空です。');
    const length = checkLength('threads', post.text ?? '');
    if (!length.ok) errors.push(`Threadsの上限(${length.max})を超えています(現在 ${length.length})。`);
    if (post.status && post.status !== 'DRAFT') {
      errors.push(`DRAFT 以外は取り込みません(${post.status})。`);
    }
    if (errors.length > 0) {
      summary.failed.push({ id: post.id, errors });
      continue;
    }

    // 元データの時間帯は「目安」として残すだけ。予約はしない。
    const suggestedSlot = post.day !== undefined && post.time
      ? `D${String(post.day).padStart(2, '0')} ${post.time}`
      : null;

    await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO posts (owner_id, title, category, cta_kind, cta_url, source, import_key, suggested_slot)
         VALUES ($1, $2, $3, 'none', NULL, 'import', $4, $5)
         RETURNING id`,
        [owner.id, post.topic ?? '', post.category, importKey, suggestedSlot],
      );
      await client.query(
        `INSERT INTO post_variants (owner_id, post_id, platform, body, state, dedupe_hash)
         VALUES ($1, $2, 'threads', $3, 'DRAFT', $4)`,
        [owner.id, rows[0].id, post.text, contentHash(normalizeForDuplicate(post.text))],
      );
    });
    summary.created += 1;
  }

  return summary;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  importPosts(process.argv[2])
    .then((summary) => {
      console.log(`投入: ${summary.created} 件 / 既存のためスキップ: ${summary.skipped} 件`);
      if (summary.failed.length > 0) {
        console.log(`取り込めなかったもの: ${summary.failed.length} 件`);
        for (const item of summary.failed) console.log(`  ${item.id}: ${item.errors.join(' / ')}`);
      }
      if (summary.created > 0) {
        console.log('すべて DRAFT です。予約日時は入れていません（元データの時間帯は目安として保持）。');
        console.log('X向けの文面は含まれません。別の下書きとして用意してください。');
      }
      return closePool();
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      await closePool();
      process.exitCode = 1;
    });
}
