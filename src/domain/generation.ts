/**
 * AI生成の出力検証。
 *
 * 出力は厳密な構造化データとして受け取り、
 * 媒体・本文・知識ID・変更理由・CTA を検証してから下書きにする。
 * 検証に通っても状態は DRAFT。自動承認・自動公開はしない。
 */

import type { Platform } from './text-length.ts';
import { checkLength } from './text-length.ts';
import type { KnowledgeItem, KnowledgeRefIssue } from './knowledge.ts';
import { validateKnowledgeReferences } from './knowledge.ts';

export const PLATFORMS = ['threads', 'x'] as const;

export const POST_CATEGORIES = [
  'intent_organizing',
  'design_specification',
  'quality_judgement',
  'general_tips',
  'announcement',
] as const;
export type PostCategory = (typeof POST_CATEGORIES)[number];

export const CTA_KINDS = ['none', 'free_material', 'sales_page', 'note_product'] as const;
export type CtaKind = (typeof CTA_KINDS)[number];

export type GeneratedDraft = {
  platform: Platform;
  body: string;
  category: PostCategory;
  knowledgeIds: string[];
  /** 直前の投稿から何を変えたか。分析/改善で根拠として使う。 */
  changeReason: string;
  cta: { kind: CtaKind; url: string | null };
};

export type ValidationIssue =
  | { code: 'schema'; field: string; message: string }
  | { code: 'length'; message: string }
  | { code: 'cta'; message: string }
  | { code: 'knowledge'; message: string; detail: KnowledgeRefIssue };

export type ValidationResult =
  | { ok: true; draft: GeneratedDraft }
  | { ok: false; issues: ValidationIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * モデル出力(JSON)を検証する。未知のキーは無視せず落とす（厳密）。
 */
export function validateGeneratedDraft(
  raw: unknown,
  context: { knowledgeById: ReadonlyMap<string, KnowledgeItem>; allowedCtaUrls: ReadonlySet<string> },
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ code: 'schema', field: '(root)', message: 'オブジェクトではありません。' }] };
  }

  const platform = raw.platform;
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
    issues.push({ code: 'schema', field: 'platform', message: `platform は ${PLATFORMS.join(' | ')} のいずれかです。` });
  }

  const body = raw.body;
  if (typeof body !== 'string' || body.trim().length === 0) {
    issues.push({ code: 'schema', field: 'body', message: 'body は空でない文字列です。' });
  }

  const category = raw.category;
  if (typeof category !== 'string' || !(POST_CATEGORIES as readonly string[]).includes(category)) {
    issues.push({ code: 'schema', field: 'category', message: 'category が不正です。' });
  }

  const knowledgeIds = raw.knowledgeIds;
  if (!Array.isArray(knowledgeIds) || knowledgeIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    issues.push({ code: 'schema', field: 'knowledgeIds', message: 'knowledgeIds は文字列の配列です。' });
  }

  const changeReason = raw.changeReason;
  if (typeof changeReason !== 'string' || changeReason.trim().length === 0) {
    issues.push({ code: 'schema', field: 'changeReason', message: 'changeReason は必須です。' });
  }

  const cta = raw.cta;
  let ctaKind: string | undefined;
  let ctaUrl: string | null = null;
  if (!isPlainObject(cta)) {
    issues.push({ code: 'schema', field: 'cta', message: 'cta はオブジェクトです。' });
  } else {
    ctaKind = typeof cta.kind === 'string' ? cta.kind : undefined;
    if (ctaKind === undefined || !(CTA_KINDS as readonly string[]).includes(ctaKind)) {
      issues.push({ code: 'schema', field: 'cta.kind', message: 'cta.kind が不正です。' });
    }
    if (cta.url === null || cta.url === undefined) ctaUrl = null;
    else if (typeof cta.url === 'string') ctaUrl = cta.url;
    else issues.push({ code: 'schema', field: 'cta.url', message: 'cta.url は文字列か null です。' });
  }

  if (issues.length > 0) return { ok: false, issues };

  const draft: GeneratedDraft = {
    platform: platform as Platform,
    body: body as string,
    category: category as PostCategory,
    knowledgeIds: knowledgeIds as string[],
    changeReason: (changeReason as string).trim(),
    cta: { kind: ctaKind as CtaKind, url: ctaUrl },
  };

  const length = checkLength(draft.platform, draft.body);
  if (!length.ok) {
    issues.push({
      code: 'length',
      message: `${draft.platform} の上限 ${length.max} に対し ${length.length} です。`,
    });
  }

  if (draft.cta.kind === 'none') {
    if (draft.cta.url !== null) issues.push({ code: 'cta', message: 'cta.kind が none のとき url は null です。' });
  } else {
    if (draft.cta.url === null) {
      issues.push({ code: 'cta', message: 'CTAの種別が指定されていますが url がありません。' });
    } else if (!context.allowedCtaUrls.has(draft.cta.url)) {
      issues.push({ code: 'cta', message: `許可されていないCTAのURLです: ${draft.cta.url}` });
    }
  }

  for (const issue of validateKnowledgeReferences({
    body: draft.body,
    knowledgeIds: draft.knowledgeIds,
    knowledgeById: context.knowledgeById,
  })) {
    issues.push({ code: 'knowledge', message: issue.message, detail: issue });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, draft };
}

/** 生成された下書きは必ず DRAFT で入る。自動承認は初期状態で無効。 */
export const GENERATION_DEFAULTS = {
  aiGenerationEnabled: false,
  autoApproveEnabled: false,
} as const;

/** 収益保証・達成時期の断定を含む表現を弾く。 */
const PROHIBITED_CLAIM_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /(必ず|確実に|100%|絶対に)[^。\n]{0,15}(稼|儲|収益|売上|成果)/u, label: '収益の保証' },
  { pattern: /\d+\s*(日|週間|ヶ月|か月|カ月|年)[^。\n]{0,10}(で|以内に)[^。\n]{0,15}(達成|稼|月収|収益化)/u, label: '達成時期の断定' },
  { pattern: /(誰でも|初心者でも)[^。\n]{0,15}(必ず|確実に|稼げ)/u, label: '無条件の成果主張' },
  { pattern: /(返金保証|元が取れ)/u, label: '保証表現' },
];

export type ProhibitedClaim = { label: string; excerpt: string };

export function detectProhibitedClaims(text: string): ProhibitedClaim[] {
  const found: ProhibitedClaim[] = [];
  for (const { pattern, label } of PROHIBITED_CLAIM_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push({ label, excerpt: match[0] });
  }
  return found;
}
