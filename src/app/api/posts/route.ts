import { NextResponse } from 'next/server';
import { withOwner, readJson, str, optionalStr, badRequest } from '../../../lib/api.ts';
import { createPost, listVariants } from '../../../db/posts.ts';
import { POST_CATEGORIES, CTA_KINDS, PLATFORMS } from '../../../domain/generation.ts';
import type { PostCategory, CtaKind } from '../../../domain/generation.ts';
import type { Platform } from '../../../domain/text-length.ts';

export const GET = withOwner(async (user) => {
  const variants = await listVariants(user.id);
  return NextResponse.json({ variants });
});

export const POST = withOwner(async (user, request) => {
  const body = await readJson(request);
  const errors: string[] = [];

  const category = str(body.category);
  if (!(POST_CATEGORIES as readonly string[]).includes(category)) errors.push('カテゴリが不正です。');

  const ctaKind = str(body.ctaKind, 'none');
  if (!(CTA_KINDS as readonly string[]).includes(ctaKind)) errors.push('CTAの種別が不正です。');

  const rawVariants = Array.isArray(body.variants) ? body.variants : [];
  const variants: { platform: Platform; body: string; knowledgeIds: string[] }[] = [];
  for (const raw of rawVariants) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const platform = str(record.platform);
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      errors.push(`媒体が不正です: ${platform}`);
      continue;
    }
    const text = str(record.body);
    if (text.trim() === '') {
      errors.push(`${platform} の本文が空です。`);
      continue;
    }
    const knowledgeIds = Array.isArray(record.knowledgeIds)
      ? record.knowledgeIds.filter((id): id is string => typeof id === 'string')
      : [];
    variants.push({ platform: platform as Platform, body: text, knowledgeIds });
  }
  if (variants.length === 0) errors.push('本文が1件も指定されていません。');
  if (errors.length > 0) return badRequest(errors);

  const result = await createPost({
    ownerId: user.id,
    title: str(body.title),
    category: category as PostCategory,
    ctaKind: ctaKind as CtaKind,
    ctaUrl: optionalStr(body.ctaUrl),
    variants,
  });

  if (!result.ok) return badRequest(result.errors);
  return NextResponse.json({ postId: result.post.id, variantIds: result.variants.map((v) => v.id) }, { status: 201 });
});
