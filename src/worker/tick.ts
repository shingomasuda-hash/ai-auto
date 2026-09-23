/**
 * 1巡ぶんの処理。CLI からも HTTP（cron）からも呼ぶ。
 *
 * サーバーレスで動かす前提があるので、**必ず上限で区切る**。
 * 実行時間の上限に当たって途中で殺されると、送信中の処理が
 * UNKNOWN として隔離され、人の手で照合する手間が増える。
 * 時間と件数の両方で budget を切り、余裕のあるうちに戻る。
 *
 * 途中で戻っても取りこぼしにはならない。残りは次の起動で拾う。
 */

import { processOnePublishJob, processOneReconcileJob } from './publish.ts';
import { processOneMetricsJob } from './metrics.ts';
import type { AdapterFactory } from './publish.ts';
import type { MetricsAdapterFactory } from './metrics.ts';
import { sweepExpiredClaims } from '../db/jobs.ts';
import { expireOverdue } from '../db/posts.ts';

export type TickOptions = {
  workerId: string;
  /**
   * この時間を超えたら、新しいジョブに手を付けずに戻る。
   * 実行中のジョブは最後までやる（途中で切らない）ので、
   * 実際の所要時間はこれより長くなりうる。余裕を持たせること。
   */
  budgetMs: number;
  /** 1巡で処理するジョブ数の上限。 */
  maxJobs: number;
  signal?: AbortSignal;
  adapterFactory?: AdapterFactory;
  metricsAdapterFactory?: MetricsAdapterFactory;
  now?: () => number;
  onEvent?: (kind: string, detail: unknown) => void;
};

export type TickSummary = {
  /** 期限切れで EXPIRED にした投稿。 */
  expired: string[];
  /** 送信前に回収して予約へ戻したジョブ。 */
  released: number;
  /** 送信中に期限切れし、UNKNOWN へ隔離した投稿。 */
  quarantined: string[];
  published: number;
  failed: number;
  unknown: number;
  skipped: number;
  metricsCaptured: number;
  reconciled: number;
  /** 処理したジョブ数の合計。 */
  processed: number;
  /** 上限に当たって途中で戻ったか。true なら残りがある。 */
  budgetExhausted: boolean;
  durationMs: number;
};

const DEFAULTS = {
  /** Vercel の既定は10秒。maxDuration を伸ばしてもここで自制する。 */
  budgetMs: 45_000,
  maxJobs: 25,
} as const;

export function defaultTickOptions(): Pick<TickOptions, 'budgetMs' | 'maxJobs'> {
  const budgetMs = Number(process.env.CRON_BUDGET_MS ?? '');
  const maxJobs = Number(process.env.CRON_MAX_JOBS ?? '');
  return {
    budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULTS.budgetMs,
    maxJobs: Number.isInteger(maxJobs) && maxJobs > 0 ? maxJobs : DEFAULTS.maxJobs,
  };
}

export async function runTick(options: TickOptions): Promise<TickSummary> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const emit = options.onEvent ?? (() => {});

  const summary: TickSummary = {
    expired: [], released: 0, quarantined: [],
    published: 0, failed: 0, unknown: 0, skipped: 0,
    metricsCaptured: 0, reconciled: 0,
    processed: 0, budgetExhausted: false, durationMs: 0,
  };

  const outOfBudget = (): boolean => {
    if (options.signal?.aborted) return true;
    if (summary.processed >= options.maxJobs) return true;
    return now() - startedAt >= options.budgetMs;
  };

  const finish = (): TickSummary => {
    summary.durationMs = now() - startedAt;
    return summary;
  };

  // 期限切れの後片付けを先に行う。送信より優先する。
  summary.expired = await expireOverdue();
  if (summary.expired.length > 0) emit('expired', summary.expired);

  const swept = await sweepExpiredClaims();
  summary.released = swept.released.length;
  summary.quarantined = swept.quarantined.map((q) => q.variantId);
  if (summary.quarantined.length > 0) emit('quarantined', summary.quarantined);

  // 送信 → 照合 → 指標 の順。送信がいちばん時間に敏感なので先に回す。
  while (!outOfBudget()) {
    const result = await processOnePublishJob({
      workerId: options.workerId,
      signal: options.signal,
      adapterFactory: options.adapterFactory,
    });
    if (result.kind === 'idle') break;
    summary.processed += 1;
    if (result.kind === 'published') summary.published += 1;
    else if (result.kind === 'failed') summary.failed += 1;
    else if (result.kind === 'unknown') summary.unknown += 1;
    else summary.skipped += 1;
    emit('publish', result);
  }

  while (!outOfBudget()) {
    const result = await processOneReconcileJob({
      workerId: options.workerId,
      signal: options.signal,
      adapterFactory: options.adapterFactory,
    });
    if (result.kind === 'idle') break;
    summary.processed += 1;
    if (result.kind === 'published' || result.kind === 'failed') summary.reconciled += 1;
    else summary.skipped += 1;
    emit('reconcile', result);
  }

  while (!outOfBudget()) {
    const result = await processOneMetricsJob({
      workerId: options.workerId,
      adapterFactory: options.metricsAdapterFactory,
    });
    if (result.kind === 'idle') break;
    summary.processed += 1;
    if (result.kind === 'captured') summary.metricsCaptured += 1;
    else summary.skipped += 1;
    emit('metrics', result);
  }

  summary.budgetExhausted = outOfBudget();
  return finish();
}

/** 何か処理したか。CLI のループが待つかどうかの判断に使う。 */
export function didWork(summary: TickSummary): boolean {
  return summary.processed > 0
    || summary.expired.length > 0
    || summary.quarantined.length > 0
    || summary.released > 0;
}
