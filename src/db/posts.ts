import type { PoolClient } from 'pg';
import { getPool, query, queryOne, withTransaction } from './pool.ts';
import { recordAudit } from './audit.ts';
import { enqueueJob } from './jobs.ts';
import { contentHash } from '../lib/crypto.ts';
import type { PostState, TransitionActor } from '../domain/post-state.ts';
import { canTransition, isEditable, requiresReapproval } from '../domain/post-state.ts';
import type { Platform } from '../domain/text-length.ts';
import { checkLength } from '../domain/text-length.ts';
import type { ScheduleViolation } from '../domain/policy.ts';
import { POLICY, checkSchedule, findDuplicate, normalizeForDuplicate } from '../domain/policy.ts';
import type { PostCategory, CtaKind } from '../domain/generation.ts';

export type PostRow = {
  id: string;
  owner_id: string;
  title: string;
  category: PostCategory;
  cta_kind: CtaKind;
  cta_url: string | null;
  source: 'manual' | 'ai' | 'import';
  import_key: string | null;
  created_at: Date;
};

export type VariantRow = {
  id: string;
  owner_id: string;
  post_id: string;
  platform: Platform;
  body: string;
  state: PostState;
  scheduled_at: Date | null;
  approved_at: Date | null;
  approved_body_hash: string | null;
  published_at: Date | null;
  external_post_id: string | null;
  dedupe_hash: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export type VariantWithPost = VariantRow & {
  title: string;
  category: PostCategory;
  cta_kind: CtaKind;
  cta_url: string | null;
  source: 'manual' | 'ai' | 'import';
};

const VARIANT_WITH_POST_SELECT = `
  SELECT v.*, p.title, p.category, p.cta_kind, p.cta_url, p.source
    FROM post_variants v
    JOIN posts p ON p.id = v.post_id
`;

/** 所有者スコープでのみ取得する。owner_id を省略できる関数を作らない。 */
export async function getVariant(ownerId: string, variantId: string): Promise<VariantWithPost | null> {
  return queryOne<VariantWithPost>(
    `${VARIANT_WITH_POST_SELECT} WHERE v.id = $1 AND v.owner_id = $2`,
    [variantId, ownerId],
  );
}

export async function listVariants(
  ownerId: string,
  filter: { platform?: Platform; states?: PostState[]; limit?: number } = {},
): Promise<VariantWithPost[]> {
  return query<VariantWithPost>(
    `${VARIANT_WITH_POST_SELECT}
      WHERE v.owner_id = $1
        AND ($2::text IS NULL OR v.platform = $2)
        AND ($3::text[] IS NULL OR v.state = ANY($3::text[]))
      ORDER BY COALESCE(v.scheduled_at, v.created_at) DESC, v.created_at DESC
      LIMIT $4`,
    [ownerId, filter.platform ?? null, filter.states ?? null, filter.limit ?? 200],
  );
}

export async function listScheduledInRange(
  ownerId: string,
  startUtc: Date,
  endUtc: Date,
): Promise<VariantWithPost[]> {
  return query<VariantWithPost>(
    `${VARIANT_WITH_POST_SELECT}
      WHERE v.owner_id = $1
        AND COALESCE(v.published_at, v.scheduled_at) >= $2
        AND COALESCE(v.published_at, v.scheduled_at) < $3
      ORDER BY COALESCE(v.published_at, v.scheduled_at)`,
    [ownerId, startUtc, endUtc],
  );
}

export type CreatePostInput = {
  ownerId: string;
  title: string;
  category: PostCategory;
  ctaKind: CtaKind;
  ctaUrl: string | null;
  source?: 'manual' | 'ai' | 'import';
  importKey?: string | null;
  /** 媒体ごとの本文。X向けは Threads とは別の下書きとして扱う。 */
  variants: { platform: Platform; body: string; knowledgeIds?: string[] }[];
};

export type CreatePostResult =
  | { ok: true; post: PostRow; variants: VariantRow[] }
  | { ok: false; errors: string[] };

export async function createPost(input: CreatePostInput): Promise<CreatePostResult> {
  const errors: string[] = [];
  if (input.variants.length === 0) errors.push('本文が1件も指定されていません。');
  for (const variant of input.variants) {
    const length = checkLength(variant.platform, variant.body);
    if (!length.ok) {
      errors.push(
        `${variant.platform} の本文が上限(${length.max})を超えています(現在 ${length.length})。`,
      );
    }
  }
  if (input.ctaKind !== 'none' && !input.ctaUrl) errors.push('CTAのURLを入力してください。');
  if (input.ctaKind === 'none' && input.ctaUrl) errors.push('CTAなしのときURLは指定できません。');
  if (errors.length > 0) return { ok: false, errors };

  return withTransaction(async (client) => {
    const { rows: postRows } = await client.query<PostRow>(
      `INSERT INTO posts (owner_id, title, category, cta_kind, cta_url, source, import_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.ownerId,
        input.title,
        input.category,
        input.ctaKind,
        input.ctaUrl,
        input.source ?? 'manual',
        input.importKey ?? null,
      ],
    );
    const post = postRows[0];

    const variants: VariantRow[] = [];
    for (const variant of input.variants) {
      const { rows } = await client.query<VariantRow>(
        `INSERT INTO post_variants (owner_id, post_id, platform, body, state, dedupe_hash)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5)
         RETURNING *`,
        [input.ownerId, post.id, variant.platform, variant.body, contentHash(normalizeForDuplicate(variant.body))],
      );
      variants.push(rows[0]);
      for (const knowledgeId of variant.knowledgeIds ?? []) {
        await client.query(
          `INSERT INTO post_knowledge_refs (variant_id, knowledge_id, owner_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [rows[0].id, knowledgeId, input.ownerId],
        );
      }
    }

    await recordAudit(
      { ownerId: input.ownerId, actor: 'owner', action: 'post.create', targetType: 'post', targetId: post.id },
      client,
    );
    return { ok: true, post, variants };
  });
}

export type UpdateBodyResult =
  | { ok: true; variant: VariantRow; reapprovalRequired: boolean }
  | { ok: false; errors: string[] };

/**
 * 本文を編集する。承認済み・予約済みで内容が変われば DRAFT へ戻し、再承認を必須にする。
 */
export async function updateVariantBody(
  ownerId: string,
  variantId: string,
  body: string,
): Promise<UpdateBodyResult> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<VariantRow>(
      `SELECT * FROM post_variants WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [variantId, ownerId],
    );
    const variant = rows[0];
    if (!variant) return { ok: false, errors: ['投稿が見つかりません。'] };
    if (!isEditable(variant.state)) {
      return { ok: false, errors: [`${variant.state} の投稿は編集できません。`] };
    }

    const length = checkLength(variant.platform, body);
    if (!length.ok) {
      return { ok: false, errors: [`本文が上限(${length.max})を超えています(現在 ${length.length})。`] };
    }

    const contentChanged = body !== variant.body;
    const reapprovalRequired = requiresReapproval(variant.state, contentChanged);
    const nextState: PostState = reapprovalRequired ? 'DRAFT' : variant.state;

    const { rows: updated } = await client.query<VariantRow>(
      `UPDATE post_variants
          SET body = $3,
              dedupe_hash = $4,
              state = $5,
              approved_at = CASE WHEN $6 THEN NULL ELSE approved_at END,
              approved_body_hash = CASE WHEN $6 THEN NULL ELSE approved_body_hash END,
              scheduled_at = CASE WHEN $6 THEN NULL ELSE scheduled_at END,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [variantId, ownerId, body, contentHash(normalizeForDuplicate(body)), nextState, reapprovalRequired],
    );

    if (reapprovalRequired) {
      // 予約が生きていたら取り消す。承認前の内容が送られてはならない。
      await client.query(
        `UPDATE jobs SET state = 'CANCELLED', updated_at = now()
          WHERE owner_id = $1 AND kind = 'publish' AND ref_id = $2 AND state = 'READY'`,
        [ownerId, variantId],
      );
      await recordAudit(
        {
          ownerId,
          actor: 'owner',
          action: 'post.reapproval_required',
          targetType: 'post_variant',
          targetId: variantId,
        },
        client,
      );
    }

    return { ok: true, variant: updated[0], reapprovalRequired };
  });
}

export type TransitionResult =
  | { ok: true; variant: VariantRow }
  | { ok: false; errors: string[]; violations?: ScheduleViolation[] };

/** 承認する。承認時点の本文ハッシュを残し、後の変更を検出できるようにする。 */
export async function approveVariant(ownerId: string, variantId: string): Promise<TransitionResult> {
  return withTransaction(async (client) => {
    const variant = await lockVariant(client, ownerId, variantId);
    if (!variant) return { ok: false, errors: ['投稿が見つかりません。'] };

    const check = canTransition(variant.state, 'APPROVED', 'owner');
    if (!check.ok) return { ok: false, errors: [check.reason] };

    const { rows } = await client.query<VariantRow>(
      `UPDATE post_variants
          SET state = 'APPROVED', approved_at = now(), approved_body_hash = $3, updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [variantId, ownerId, contentHash(variant.body)],
    );
    await recordAudit(
      { ownerId, actor: 'owner', action: 'post.approve', targetType: 'post_variant', targetId: variantId },
      client,
    );
    return { ok: true, variant: rows[0] };
  });
}

export type ScheduleOptions = { allowDuplicate?: boolean; now?: Date };

/** 予約する。運営ポリシー(1日3件・2時間間隔・過去不可)を満たす場合のみ。 */
export async function scheduleVariant(
  ownerId: string,
  variantId: string,
  at: Date,
  options: ScheduleOptions = {},
): Promise<TransitionResult> {
  const now = options.now ?? new Date();
  return withTransaction(async (client) => {
    const variant = await lockVariant(client, ownerId, variantId);
    if (!variant) return { ok: false, errors: ['投稿が見つかりません。'] };

    const check = canTransition(variant.state, 'SCHEDULED', 'owner');
    if (!check.ok) return { ok: false, errors: [check.reason] };

    // 承認後に本文が変わっていないことを確かめる。
    if (variant.approved_body_hash !== contentHash(variant.body)) {
      return { ok: false, errors: ['承認後に本文が変更されています。再承認してください。'] };
    }

    const { rows: existing } = await client.query<{ id: string; platform: Platform; at: Date }>(
      `SELECT id, platform, COALESCE(published_at, scheduled_at) AS at
         FROM post_variants
        WHERE owner_id = $1 AND id <> $2 AND platform = $3
          AND state IN ('SCHEDULED', 'CLAIMED', 'PUBLISHING', 'PUBLISHED')
          AND COALESCE(published_at, scheduled_at) IS NOT NULL`,
      [ownerId, variantId, variant.platform],
    );

    const violations = checkSchedule({ platform: variant.platform, at, existing, now });
    if (violations.length > 0) {
      return { ok: false, errors: violations.map((v) => v.message), violations };
    }

    if (!options.allowDuplicate) {
      const { rows: recent } = await client.query<{ id: string; body: string; at: Date }>(
        `SELECT id, body, COALESCE(published_at, scheduled_at, created_at) AS at
           FROM post_variants
          WHERE owner_id = $1 AND id <> $2 AND platform = $3 AND state <> 'EXPIRED'`,
        [ownerId, variantId, variant.platform],
      );
      const duplicate = findDuplicate(variant.body, recent, now);
      if (duplicate) {
        return {
          ok: false,
          errors: [
            `直近${POLICY.duplicateLookbackMs / 86_400_000}日以内に同じ内容の投稿があります(${duplicate.id})。意図的なら重複を許可して再実行してください。`,
          ],
        };
      }
    }

    const { rows } = await client.query<VariantRow>(
      `UPDATE post_variants
          SET state = 'SCHEDULED', scheduled_at = $3, last_error = NULL, updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [variantId, ownerId, at],
    );
    await enqueueJob({ ownerId, kind: 'publish', refId: variantId, runAfter: at }, client);
    await recordAudit(
      {
        ownerId,
        actor: 'owner',
        action: 'post.schedule',
        targetType: 'post_variant',
        targetId: variantId,
        detail: { scheduledAt: at.toISOString() },
      },
      client,
    );
    return { ok: true, variant: rows[0] };
  });
}

/** 予約を取り消す。送信前のみ可能。 */
export async function cancelSchedule(ownerId: string, variantId: string): Promise<TransitionResult> {
  return withTransaction(async (client) => {
    const variant = await lockVariant(client, ownerId, variantId);
    if (!variant) return { ok: false, errors: ['投稿が見つかりません。'] };

    const check = canTransition(variant.state, 'APPROVED', 'owner');
    if (!check.ok) return { ok: false, errors: [check.reason] };

    const { rows } = await client.query<VariantRow>(
      `UPDATE post_variants
          SET state = 'APPROVED', scheduled_at = NULL, updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [variantId, ownerId],
    );
    await client.query(
      `UPDATE jobs SET state = 'CANCELLED', updated_at = now()
        WHERE owner_id = $1 AND kind = 'publish' AND ref_id = $2 AND state = 'READY'`,
      [ownerId, variantId],
    );
    await recordAudit(
      { ownerId, actor: 'owner', action: 'post.cancel_schedule', targetType: 'post_variant', targetId: variantId },
      client,
    );
    return { ok: true, variant: rows[0] };
  });
}

/** 承認を取り消して下書きへ戻す。 */
export async function revertToDraft(ownerId: string, variantId: string): Promise<TransitionResult> {
  return withTransaction(async (client) => {
    const variant = await lockVariant(client, ownerId, variantId);
    if (!variant) return { ok: false, errors: ['投稿が見つかりません。'] };
    const check = canTransition(variant.state, 'DRAFT', 'owner');
    if (!check.ok) return { ok: false, errors: [check.reason] };

    const { rows } = await client.query<VariantRow>(
      `UPDATE post_variants
          SET state = 'DRAFT', approved_at = NULL, approved_body_hash = NULL,
              scheduled_at = NULL, updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [variantId, ownerId],
    );
    await client.query(
      `UPDATE jobs SET state = 'CANCELLED', updated_at = now()
        WHERE owner_id = $1 AND kind = 'publish' AND ref_id = $2 AND state = 'READY'`,
      [ownerId, variantId],
    );
    return { ok: true, variant: rows[0] };
  });
}

async function lockVariant(client: PoolClient, ownerId: string, variantId: string): Promise<VariantRow | null> {
  const { rows } = await client.query<VariantRow>(
    `SELECT * FROM post_variants WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
    [variantId, ownerId],
  );
  return rows[0] ?? null;
}

/**
 * 期限切れの予約を EXPIRED にする。
 * 猶予を過ぎたものを「まとめて投稿し直す」ことは絶対にしない。
 */
export async function expireOverdue(now: Date = new Date()): Promise<string[]> {
  return withTransaction(async (client) => {
    const cutoff = new Date(now.getTime() - POLICY.scheduleGraceMs);
    const { rows } = await client.query<{ id: string; owner_id: string }>(
      `UPDATE post_variants
          SET state = 'EXPIRED', last_error = '予約時刻から24時間以上経過したため期限切れ', updated_at = now()
        WHERE state IN ('SCHEDULED', 'CLAIMED')
          AND scheduled_at IS NOT NULL
          AND scheduled_at < $1
        RETURNING id, owner_id`,
      [cutoff],
    );
    for (const row of rows) {
      await client.query(
        `UPDATE jobs SET state = 'CANCELLED', last_error = 'expired', updated_at = now()
          WHERE kind = 'publish' AND ref_id = $1 AND state IN ('READY', 'CLAIMED')`,
        [row.id],
      );
      await recordAudit(
        { ownerId: row.owner_id, actor: 'scheduler', action: 'post.expire', targetType: 'post_variant', targetId: row.id },
        client,
      );
    }
    return rows.map((r) => r.id);
  });
}

/** ワーカーが状態を進める。actor は 'worker'。 */
export async function transitionByWorker(
  ownerId: string,
  variantId: string,
  to: PostState,
  patch: Partial<Pick<VariantRow, 'external_post_id' | 'last_error'>> = {},
  actor: TransitionActor = 'worker',
): Promise<TransitionResult> {
  return withTransaction(async (client) => {
    const variant = await lockVariant(client, ownerId, variantId);
    if (!variant) return { ok: false, errors: ['投稿が見つかりません。'] };
    const check = canTransition(variant.state, to, actor);
    if (!check.ok) return { ok: false, errors: [check.reason] };

    const { rows } = await client.query<VariantRow>(
      `UPDATE post_variants
          SET state = $3,
              external_post_id = COALESCE($4, external_post_id),
              published_at = CASE WHEN $3 = 'PUBLISHED' THEN now() ELSE published_at END,
              last_error = $5,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [variantId, ownerId, to, patch.external_post_id ?? null, patch.last_error ?? null],
    );
    return { ok: true, variant: rows[0] };
  });
}

export async function getPostCounts(ownerId: string): Promise<Record<PostState, number>> {
  const rows = await query<{ state: PostState; count: string }>(
    `SELECT state, count(*)::text AS count FROM post_variants WHERE owner_id = $1 GROUP BY state`,
    [ownerId],
  );
  const counts = {} as Record<PostState, number>;
  for (const row of rows) counts[row.state] = Number(row.count);
  return counts;
}

export async function getKnowledgeRefs(ownerId: string, variantId: string): Promise<{ id: string; title: string; kind: string }[]> {
  return query<{ id: string; title: string; kind: string }>(
    `SELECT k.id, k.title, k.kind
       FROM post_knowledge_refs r
       JOIN knowledge k ON k.id = r.knowledge_id
      WHERE r.variant_id = $1 AND r.owner_id = $2
      ORDER BY k.title`,
    [variantId, ownerId],
  );
}

export { getPool };
