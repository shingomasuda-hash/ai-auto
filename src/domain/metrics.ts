/**
 * 反応指標の比較。
 *
 * 原則:
 *  - 公開後の経過時間をそろえて比較する（24h/72h など）。
 *  - 取得できない指標は NULL のまま扱い、0 に置き換えない。
 *  - いいね数だけで評価しない。クリック等を併記する。
 *  - 投稿と売上を直接紐付けられない限り、相関を購入寄与として扱わない。
 *  - 少量データで勝ちパターンを断定しない。
 */

import { HOUR_MS } from './time.ts';

/** 比較に使う経過時間バケット。 */
export const ELAPSED_BUCKETS_HOURS = [1, 24, 72, 168] as const;
export type ElapsedBucketHours = (typeof ELAPSED_BUCKETS_HOURS)[number];

/** バケットに割り当てる際の許容誤差（±）。 */
export const BUCKET_TOLERANCE_MS = 2 * HOUR_MS;

/** 断定を避けるための最小標本数。これ未満は「参考値」とする。 */
export const MIN_SAMPLES_FOR_COMPARISON = 5;

export type MetricValues = {
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  /** 内部クリックIDで数えた遷移数。媒体指標ではない。 */
  linkClicks: number | null;
};

export const METRIC_KEYS = ['impressions', 'likes', 'replies', 'reposts', 'linkClicks'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type Snapshot = {
  postId: string;
  publishedAt: Date;
  capturedAt: Date;
  values: MetricValues;
};

export function elapsedMs(snapshot: Snapshot): number {
  return snapshot.capturedAt.getTime() - snapshot.publishedAt.getTime();
}

/** スナップショットを経過時間バケットへ割り当てる。合わなければ null。 */
export function bucketOf(snapshot: Snapshot): ElapsedBucketHours | null {
  const elapsed = elapsedMs(snapshot);
  for (const hours of ELAPSED_BUCKETS_HOURS) {
    if (Math.abs(elapsed - hours * HOUR_MS) <= BUCKET_TOLERANCE_MS) return hours;
  }
  return null;
}

/** 同一バケットのスナップショットだけを取り出す。 */
export function snapshotsInBucket(snapshots: readonly Snapshot[], bucket: ElapsedBucketHours): Snapshot[] {
  return snapshots.filter((s) => bucketOf(s) === bucket);
}

/**
 * 投稿ごとに、指定バケットの最新スナップショットを1件選ぶ。
 */
export function latestPerPost(snapshots: readonly Snapshot[], bucket: ElapsedBucketHours): Map<string, Snapshot> {
  const chosen = new Map<string, Snapshot>();
  for (const snapshot of snapshotsInBucket(snapshots, bucket)) {
    const current = chosen.get(snapshot.postId);
    if (!current || snapshot.capturedAt > current.capturedAt) chosen.set(snapshot.postId, snapshot);
  }
  return chosen;
}

export type GroupComparison = {
  metric: MetricKey;
  bucketHours: ElapsedBucketHours;
  groups: {
    label: string;
    /** 値が取得できた投稿数。 */
    sampleSize: number;
    /** 値が取得できなかった投稿数。 */
    missingCount: number;
    mean: number | null;
    median: number | null;
  }[];
  /** 標本が少ない等の理由で断定できない場合の注意書き。 */
  cautions: string[];
  /** 断定的な結論を出してよいか。 */
  conclusive: boolean;
};

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type LabeledPost = { postId: string; label: string };

/**
 * 同一バケット・同一指標でグループを比較する。
 * 標本が少なければ conclusive=false を返し、UI 側で断定表現を禁止する。
 */
export function compareGroups(
  snapshots: readonly Snapshot[],
  posts: readonly LabeledPost[],
  metric: MetricKey,
  bucketHours: ElapsedBucketHours,
): GroupComparison {
  const chosen = latestPerPost(snapshots, bucketHours);
  const byLabel = new Map<string, { values: number[]; missing: number }>();

  for (const post of posts) {
    const entry = byLabel.get(post.label) ?? { values: [], missing: 0 };
    const snapshot = chosen.get(post.postId);
    const value = snapshot ? snapshot.values[metric] : null;
    if (value === null || value === undefined) entry.missing += 1;
    else entry.values.push(value);
    byLabel.set(post.label, entry);
  }

  const groups = [...byLabel.entries()].map(([label, entry]) => ({
    label,
    sampleSize: entry.values.length,
    missingCount: entry.missing,
    mean: mean(entry.values),
    median: median(entry.values),
  }));

  const cautions: string[] = [];
  const smallest = groups.length === 0 ? 0 : Math.min(...groups.map((g) => g.sampleSize));
  if (groups.length < 2) cautions.push('比較対象が2群に満たないため比較できません。');
  if (smallest < MIN_SAMPLES_FOR_COMPARISON) {
    cautions.push(
      `標本数が少ないため（最小${smallest}件 / 目安${MIN_SAMPLES_FOR_COMPARISON}件）、傾向の断定はできません。参考値として扱ってください。`,
    );
  }
  if (groups.some((g) => g.missingCount > 0)) {
    cautions.push('一部の投稿で指標を取得できていません。欠測は0として扱っていません。');
  }
  if (metric === 'likes') {
    cautions.push('いいね数のみでは評価できません。クリック等と併せて判断してください。');
  }

  return { metric, bucketHours, groups, cautions, conclusive: cautions.length === 0 };
}

/**
 * 売上への寄与。
 * 個別購入と投稿を直接紐付けられない限り、寄与は「不明」を返す。
 */
export type AttributionInput = {
  /** 購入と投稿を一意に結びつけられる仕組みがあるか（例: 購入側が clickId を返す）。 */
  perPurchaseLinkAvailable: boolean;
  clicksByPost: ReadonlyMap<string, number>;
  totalSalesCount: number;
};

export type AttributionResult =
  | { kind: 'measured'; byPost: ReadonlyMap<string, number> }
  | { kind: 'unavailable'; reason: string; observedClicksByPost: ReadonlyMap<string, number> };

export function attributeSales(input: AttributionInput): AttributionResult {
  if (!input.perPurchaseLinkAvailable) {
    return {
      kind: 'unavailable',
      reason:
        '購入データと投稿を1件単位で結び付ける手段がありません。クリック数は観測値として表示しますが、購入寄与としては扱いません。',
      observedClicksByPost: input.clicksByPost,
    };
  }
  // 実測の紐付けが利用可能になった場合のみ、ここで実測値を返す。
  return { kind: 'measured', byPost: new Map() };
}
