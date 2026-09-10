/**
 * 既存の投稿を DRAFT として冪等に投入する。
 *
 * - importKey が同じものは二度入らない。
 * - 日時は入れない。予約も公開もしない。承認もしない。
 * - X向けの文面は Threads とは別の下書きとして作られる。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../src/db/pool.ts';
import { createPost } from '../src/db/posts.ts';
import type { PostCategory, CtaKind } from '../src/domain/generation.ts';
import type { Platform } from '../src/domain/text-length.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

type SeedPost = {
  importKey: string;
  title: string;
  category: PostCategory;
  ctaKind: CtaKind;
  ctaUrl: string | null;
  variants: { platform: Platform; body: string }[];
};

export type ImportSummary = { created: number; skipped: number; failed: { importKey: string; errors: string[] }[] };

export async function importPosts(ownerEmail?: string): Promise<ImportSummary> {
  const owners = await query<{ id: string }>(
    `SELECT id FROM users ${ownerEmail ? 'WHERE lower(email) = lower($1)' : ''} ORDER BY created_at LIMIT 1`,
    ownerEmail ? [ownerEmail] : [],
  );
  const owner = owners[0];
  if (!owner) throw new Error('所有者が見つかりません。先に admin:create を実行してください。');

  const file = JSON.parse(
    await readFile(path.join(ROOT, 'content/posts-seed.json'), 'utf8'),
  ) as { posts: SeedPost[] };

  const existing = new Set(
    (await query<{ import_key: string }>(
      `SELECT import_key FROM posts WHERE owner_id = $1 AND import_key IS NOT NULL`, [owner.id],
    )).map((r) => r.import_key),
  );

  const summary: ImportSummary = { created: 0, skipped: 0, failed: [] };

  for (const post of file.posts) {
    if (existing.has(post.importKey)) {
      summary.skipped += 1;
      continue;
    }
    const result = await createPost({
      ownerId: owner.id,
      title: post.title,
      category: post.category,
      ctaKind: post.ctaKind,
      ctaUrl: post.ctaUrl,
      source: 'import',
      importKey: post.importKey,
      variants: post.variants,
    });
    if (result.ok) summary.created += 1;
    else summary.failed.push({ importKey: post.importKey, errors: result.errors });
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
        for (const item of summary.failed) console.log(`  ${item.importKey}: ${item.errors.join(' / ')}`);
      }
      if (summary.created === 0 && summary.skipped === 0) {
        console.log('content/posts-seed.json に投稿がありません。既存の90投稿はここに置いてください。');
      }
      return closePool();
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      await closePool();
      process.exitCode = 1;
    });
}
