/**
 * 運営ポリシー（自主的な上限）。
 *
 * ここで定義する上限は「運営上の上限」であり、各媒体のAPI上限を表すものではない。
 * API側の上限は別途アダプター層で 429 等として扱う。
 */

import { DAY_MS, HOUR_MS, formatJst } from './time.ts';
import type { Platform } from './text-length.ts';
import { checkLength } from './text-length.ts';

export const POLICY = {
  /**
   * 媒体ごとの投稿上限。
   *
   * 数え方は「直近24時間の移動窓」であって、JSTの暦日ではない。
   * 暦日で数えると、23:00 に3件・翌00:30 に3件が通ってしまい、
   * 実質2時間半で6件になる。移動窓ならこれを防げる。
   * reference/Code.gs の試作もこの数え方をしている。
   */
  maxPostsPerPlatformPer24h: 3,
  /** 同一媒体で連続投稿の最小間隔。 */
  minIntervalMs: 2 * HOUR_MS,
  /** 予約時刻からこの時間を過ぎたら EXPIRED（一斉投稿しない）。 */
  scheduleGraceMs: 24 * HOUR_MS,
  /** claim の有効期限。過ぎた CLAIMED/PUBLISHING は回収対象。 */
  claimLeaseMs: 5 * 60_000,
  /** 上限を数える移動窓の幅。 */
  rateWindowMs: 24 * HOUR_MS,
  /** 内容の重複とみなす直近期間。 */
  duplicateLookbackMs: 30 * DAY_MS,
} as const;

export type ScheduledLike = {
  id: string;
  platform: Platform;
  /** 予約時刻、または実際の公開時刻。 */
  at: Date;
};

export type ScheduleViolation =
  | { code: 'daily_limit'; message: string; limit: number; windowHours: number }
  | { code: 'min_interval'; message: string; minIntervalMs: number; conflictId: string }
  | { code: 'in_past'; message: string }
  | { code: 'beyond_grace'; message: string };

export type ScheduleCheckInput = {
  platform: Platform;
  /** 予約したい時刻(UTC)。 */
  at: Date;
  /** 同一所有者・同一媒体の既存の予約/公開済み一覧（自分自身は除いておく）。 */
  existing: readonly ScheduledLike[];
  now: Date;
};

/**
 * 予約時刻が運営ポリシーに反していないか調べる。
 * 反したものをすべて返す（最初の1件で打ち切らない）。
 */
export function checkSchedule(input: ScheduleCheckInput): ScheduleViolation[] {
  const violations: ScheduleViolation[] = [];
  const { platform, at, now } = input;

  if (at.getTime() <= now.getTime()) {
    violations.push({ code: 'in_past', message: '予約時刻が現在時刻より前です。' });
  }

  const samePlatform = input.existing.filter((e) => e.platform === platform);

  // 予約したい時刻を終端とする直近24時間の移動窓で数える。
  const windowStart = at.getTime() - POLICY.rateWindowMs;
  const inWindow = samePlatform.filter(
    (e) => e.at.getTime() > windowStart && e.at.getTime() <= at.getTime(),
  );
  if (inWindow.length >= POLICY.maxPostsPerPlatformPer24h) {
    violations.push({
      code: 'daily_limit',
      message: `${formatJst(at)} までの24時間に${platform}の投稿が${inWindow.length}件あります。運営上限は24時間で${POLICY.maxPostsPerPlatformPer24h}件です。`,
      limit: POLICY.maxPostsPerPlatformPer24h,
      windowHours: POLICY.rateWindowMs / HOUR_MS,
    });
  }

  const tooClose = samePlatform.find(
    (e) => Math.abs(e.at.getTime() - at.getTime()) < POLICY.minIntervalMs,
  );
  if (tooClose) {
    violations.push({
      code: 'min_interval',
      message: `同一媒体の投稿は${POLICY.minIntervalMs / HOUR_MS}時間以上あけてください。`,
      minIntervalMs: POLICY.minIntervalMs,
      conflictId: tooClose.id,
    });
  }

  return violations;
}

/** 予約が期限切れ（猶予超過）か。 */
export function isExpired(scheduledAt: Date, now: Date, graceMs: number = POLICY.scheduleGraceMs): boolean {
  return now.getTime() - scheduledAt.getTime() > graceMs;
}

/** claim のリース期限が切れているか。 */
export function isClaimExpired(claimedAt: Date, now: Date, leaseMs: number = POLICY.claimLeaseMs): boolean {
  return now.getTime() - claimedAt.getTime() > leaseMs;
}

/**
 * 送信可能かの最終判定。ワーカーが「送信直前」に必ず呼ぶ。
 * 停止(kill switch)は毎回ここで確認する。
 */
export type SendGateInput = {
  platform: Platform;
  body: string;
  scheduledAt: Date;
  now: Date;
  /** 全体停止フラグ。 */
  globalStop: boolean;
  /** 媒体ごとの停止フラグ。 */
  platformStop: boolean;
  /** 媒体の接続が本番かどうか。false のとき本番送信をしてはならない。 */
  connectionMode: 'live' | 'simulated' | 'disconnected';
  /**
   * 同一媒体で「実際に公開された」時刻の一覧。
   *
   * 予約時の検査だけでは上限を守れない。予約が遅延したり、
   * 予約後に別の投稿が公開されたりすると、予約時点の前提が崩れる。
   * 送信直前に、実績にもとづいて数え直す。
   */
  recentPublishedAt?: readonly Date[];
};

export type SendGateResult =
  | { allowed: true }
  | {
      allowed: false;
      code: 'stopped' | 'expired' | 'too_long' | 'empty' | 'not_connected' | 'rate_limited' | 'min_interval';
      message: string;
      /** 再試行してよい時刻。上限に当たった場合のみ。 */
      retryAt?: Date;
    };

export function evaluateSendGate(input: SendGateInput): SendGateResult {
  if (input.globalStop || input.platformStop) {
    return { allowed: false, code: 'stopped', message: '処理が停止されています。' };
  }
  if (input.connectionMode === 'disconnected') {
    return { allowed: false, code: 'not_connected', message: '媒体が未接続です。' };
  }
  if (isExpired(input.scheduledAt, input.now)) {
    return { allowed: false, code: 'expired', message: '予約時刻から24時間以上経過しています。' };
  }
  const length = checkLength(input.platform, input.body);
  if (input.body.trim().length === 0) {
    return { allowed: false, code: 'empty', message: '本文が空です。' };
  }
  if (!length.ok) {
    return {
      allowed: false,
      code: 'too_long',
      message: `本文が${input.platform}の上限(${length.max})を${-length.remaining}超えています。`,
    };
  }

  // 実際に公開された時刻で上限を数え直す。
  const published = [...(input.recentPublishedAt ?? [])].sort((a, b) => b.getTime() - a.getTime());
  const nowMs = input.now.getTime();

  const inWindow = published.filter((at) => nowMs - at.getTime() < POLICY.rateWindowMs);
  if (inWindow.length >= POLICY.maxPostsPerPlatformPer24h) {
    // 窓から最も古い1件が抜ける時刻まで待つ。
    const oldest = inWindow[inWindow.length - 1];
    return {
      allowed: false,
      code: 'rate_limited',
      message: `直近24時間に${input.platform}の投稿が${inWindow.length}件あります。運営上限は${POLICY.maxPostsPerPlatformPer24h}件です。`,
      retryAt: new Date(oldest.getTime() + POLICY.rateWindowMs),
    };
  }

  const latest = published[0];
  if (latest && nowMs - latest.getTime() < POLICY.minIntervalMs) {
    return {
      allowed: false,
      code: 'min_interval',
      message: `直前の${input.platform}投稿から${POLICY.minIntervalMs / HOUR_MS}時間経っていません。`,
      retryAt: new Date(latest.getTime() + POLICY.minIntervalMs),
    };
  }

  return { allowed: true };
}

/**
 * 重複検出用の正規化。
 *
 * 注意: このハッシュは「似た内容を管理者に警告する」ためのもので、
 * 送信の冪等性を保証しない。冪等性は publish_attempts の一意キーと
 * 外部IDの照合で担保する。
 */
export function normalizeForDuplicate(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(URL_FOR_NORMALIZE, ' ')
    .replace(/[#＃@＠]/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const URL_FOR_NORMALIZE = /\bhttps?:\/\/\S+/gi;

/** 正規化後の内容が一致する既存投稿を返す。 */
export function findDuplicate<T extends { id: string; body: string; at: Date }>(
  body: string,
  existing: readonly T[],
  now: Date,
  lookbackMs: number = POLICY.duplicateLookbackMs,
): T | null {
  const target = normalizeForDuplicate(body);
  if (target.length === 0) return null;
  const since = now.getTime() - lookbackMs;
  return existing.find((e) => e.at.getTime() >= since && normalizeForDuplicate(e.body) === target) ?? null;
}
