/**
 * 改善提案。
 *
 * 「観測事実」「仮説」「次回の変更点」を必ず分けて保持する。
 * 初期は管理者の承認が必須で、自動適用しない。
 */

export const PROPOSAL_STATES = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export type ImprovementProposal = {
  /** 観測できた事実のみ。推測を混ぜない。 */
  observations: string[];
  /** 事実から立てた仮説。断定しない。 */
  hypotheses: string[];
  /** 次回の投稿で変える具体的な要素。 */
  changes: string[];
  /** 根拠として参照した指標スナップショット等のID。 */
  evidenceIds: string[];
  /** 標本が少ない等の注意書き。 */
  cautions: string[];
};

export type ProposalIssue = { field: keyof ImprovementProposal | '(root)'; message: string };

export function validateProposal(raw: unknown): { ok: true; value: ImprovementProposal } | { ok: false; issues: ProposalIssue[] } {
  const issues: ProposalIssue[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: '(root)', message: 'オブジェクトではありません。' }] };
  }
  const record = raw as Record<string, unknown>;

  const stringArray = (field: keyof ImprovementProposal, required: boolean): string[] => {
    const value = record[field];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      issues.push({ field, message: `${field} は文字列の配列です。` });
      return [];
    }
    const cleaned = (value as string[]).map((v) => v.trim()).filter((v) => v.length > 0);
    if (required && cleaned.length === 0) issues.push({ field, message: `${field} は1件以上必要です。` });
    return cleaned;
  };

  const observations = stringArray('observations', true);
  const hypotheses = stringArray('hypotheses', true);
  const changes = stringArray('changes', true);
  const evidenceIds = stringArray('evidenceIds', true);
  const cautions = stringArray('cautions', false);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { observations, hypotheses, changes, evidenceIds, cautions } };
}

/** 提案の採否は必ず管理者が決める。自動適用の入口を作らない。 */
export function canAutoApply(): false {
  return false;
}
