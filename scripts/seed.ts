/**
 * content/*.json を投入する。何度実行しても増えない（冪等）。
 *
 * 投入するのは:
 *  - 商品（現行の販売案）
 *  - 知識（本人が提供したもののみ。空なら何もしない）
 *  - 月次の予算枠
 *
 * 既存投稿の投入は scripts/import-posts.ts が担当する。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closePool } from '../src/db/pool.ts';
import { upsertProduct } from '../src/db/products.ts';
import { createKnowledge, listKnowledge } from '../src/db/knowledge.ts';
import { ensureEnvelopes } from '../src/db/budget.ts';
import { updateSettings } from '../src/db/settings.ts';
import { jstMonthKey } from '../src/domain/time.ts';
import type { KnowledgeKind } from '../src/domain/knowledge.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(path.join(ROOT, relative), 'utf8')) as T;
}

export async function seed(ownerEmail?: string): Promise<void> {
  const owners = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users ${ownerEmail ? 'WHERE lower(email) = lower($1)' : ''} ORDER BY created_at LIMIT 1`,
    ownerEmail ? [ownerEmail] : [],
  );
  const owner = owners[0];
  if (!owner) {
    console.error('所有者が見つかりません。先に `npm run admin:create -- <email>` を実行してください。');
    process.exitCode = 1;
    return;
  }

  await ensureEnvelopes(owner.id, jstMonthKey(new Date()));

  const products = await readJson<{
    products: {
      code: string; name: string; priceYen: number; noteUrl: string | null;
      composition: string[]; isPublished: boolean;
    }[];
    salesPageUrl?: string | null;
  }>('content/products.json');
  for (const product of products.products) {
    await upsertProduct(owner.id, product);
  }
  console.log(`商品: ${products.products.length} 件を反映しました。`);

  // 既存の販売ページはCTAの許可先として登録する（新規に作らない）。
  if (products.salesPageUrl) {
    await updateSettings(owner.id, { sales_page_url: products.salesPageUrl });
    console.log(`販売ページ: ${products.salesPageUrl} を許可先に登録しました。`);
  }

  // content/operator-facts.json はキット収録の形式
  //   [{ id, kind, approved, text }]
  // をそのまま読む。本人が提供した内容以外を足さない。
  const facts = await readJson<
    { id: string; kind: KnowledgeKind; approved: boolean; text: string }[]
  >('content/operator-facts.json');

  if (facts.length === 0) {
    console.log('知識: content/operator-facts.json が空のため、投入しませんでした。');
    console.log('      本人が提供した内容だけを記入してください。推測で埋めないでください。');
  } else {
    const existing = new Set(
      (await listKnowledge(owner.id)).map((k) => k.source_key).filter((key): key is string => key !== null),
    );
    let added = 0;
    for (const item of facts) {
      if (existing.has(item.id)) continue;
      await createKnowledge(owner.id, {
        kind: item.kind,
        // 見出しは本文の先頭から作るだけで、内容を足さない。
        title: headline(item.text),
        body: item.text,
        source: item.kind === 'operator_experience' ? 'operator' : 'general',
        sourceKey: item.id,
        // 本人が approved として提供したものだけ APPROVED で入れる。
        state: item.approved === true ? 'APPROVED' : 'DRAFT',
      });
      added += 1;
    }
    const operatorCount = facts.filter((f) => f.kind === 'operator_experience' && f.approved).length;
    console.log(`知識: ${added} 件を追加しました（既存 ${facts.length - added} 件はそのまま）。`);
    console.log(`      本人の経験として使えるのはこの ${operatorCount} 件だけです。`);
  }
}

/** 本文の先頭から見出しを作る。要約も補完もしない。 */
function headline(text: string, max = 28): string {
  const head = text.split(/[。\n]/)[0].trim();
  const source = head.length > 0 ? head : text.trim();
  return Array.from(source).length <= max
    ? source
    : `${Array.from(source).slice(0, max).join('')}…`;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  seed(process.argv[2])
    .then(() => closePool())
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exitCode = 1;
    });
}
