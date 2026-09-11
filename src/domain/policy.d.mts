/**
 * キット収録の src/domain/policy.mjs に対する型宣言。
 *
 * policy.mjs 本体は改変しない（キットのテストをそのまま維持するため）。
 * このファイルは型付けだけを足す。実装を変えたらここも直すこと。
 */

export type RevenueSummary = {
  netSalesYen: number;
  profitYen: number | null;
  feesKnown: boolean;
};

export function revenueSummary(input: {
  grossYen: number;
  refundsYen?: number;
  feesYen?: number | null;
  operatingYen?: number;
}): RevenueSummary;

export type BudgetDecision = {
  allowed: boolean;
  projectedYen: number;
  remainingYen: number;
  warning: boolean;
  reason: 'PRICING_UNKNOWN' | 'BUDGET_EXCEEDED' | 'WITHIN_BUDGET';
};

export function budgetDecision(input: {
  capYen: number;
  spentYen: number;
  reservedYen: number;
  estimateYen: number;
  pricingKnown?: boolean;
}): BudgetDecision;

export function transition(from: string, to: string): string;

export function reconcileUnknown(input: {
  outcome: string;
  externalPostId?: string;
}): { status: 'PUBLISHED' | 'DRAFT' | 'UNKNOWN'; externalPostId: string | null };

export type ScheduleDecision = {
  allowed: boolean;
  reason: 'STOPPED' | 'NOT_DUE' | 'EXPIRED' | 'DAILY_CAP' | 'MIN_GAP' | 'READY';
};

export function scheduleDecision(input: {
  nowMs: number;
  dueMs: number;
  publishedAtMs?: number[];
  enabled?: boolean;
  maxPer24h?: number;
  minGapMs?: number;
  expiryMs?: number;
}): ScheduleDecision;

export function validateKnowledgeReferences<T extends { id: string; approved?: boolean }>(
  ids: string[],
  knowledge: T[],
): T[];
