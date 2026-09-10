/**
 * 媒体ごとの文字数計算。
 *
 * X: twitter-text の「重み付き文字数」仕様に従う。
 *   scale=100 / defaultWeight=200 / maxWeightedTweetLength=280 /
 *   transformedURLLength=23 / 下記 RANGES に含まれる符号位置は weight=100。
 *   つまりラテン文字等は1、CJK等は2として数え、上限は280。
 *   URLは実長に関わらず23として数える。絵文字は結合シーケンス全体で1文字(=2)。
 *   → 日本語のみの本文なら実質140文字。
 *
 * Threads: 公開されている上限は500文字。公式に重み付けの計算式が
 *   公開されていないため、ここでは「符号位置数」という安全側（多め）の
 *   数え方を使う。結合絵文字は分解されて多めに数えられる。
 *
 * この値は src/domain/text-length.ts の定数一箇所で管理する。
 * 媒体側の仕様変更時はここだけを更新し、テストで固定する。
 */

export type Platform = 'threads' | 'x';

export const X_CONFIG = {
  version: 3,
  maxWeightedLength: 280,
  scale: 100,
  defaultWeight: 200,
  transformedUrlLength: 23,
  ranges: [
    { start: 0, end: 4351, weight: 100 },
    { start: 8192, end: 8205, weight: 100 },
    { start: 8208, end: 8223, weight: 100 },
    { start: 8242, end: 8247, weight: 100 },
  ],
} as const;

export const THREADS_CONFIG = {
  maxLength: 500,
  countingMethod: 'codepoints (conservative; official weighting is not published)',
} as const;

/** twitter-text と同等のURL検出。仕様の完全再現ではないので安全側に倒す。 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'）」】]+/gi;

const EMOJI_PATTERN = /\p{RGI_Emoji}/gv;

function codePointWeight(codePoint: number): number {
  for (const range of X_CONFIG.ranges) {
    if (codePoint >= range.start && codePoint <= range.end) return range.weight;
  }
  return X_CONFIG.defaultWeight;
}

/**
 * Xの重み付き文字数を返す（scale適用後の整数、切り上げ）。
 */
export function weightedLengthX(text: string): number {
  let weight = 0;
  let rest = text;

  // URLは実長に関わらず固定長として数える。
  const urls = rest.match(URL_PATTERN) ?? [];
  weight += urls.length * X_CONFIG.transformedUrlLength * X_CONFIG.scale;
  rest = rest.replace(URL_PATTERN, '');

  // 絵文字(結合シーケンス含む)は1文字として数える。
  const emojis = rest.match(EMOJI_PATTERN) ?? [];
  weight += emojis.length * X_CONFIG.defaultWeight;
  rest = rest.replace(EMOJI_PATTERN, '');

  for (const char of rest) {
    weight += codePointWeight(char.codePointAt(0)!);
  }

  return Math.ceil(weight / X_CONFIG.scale);
}

/** Threadsの文字数（安全側: 符号位置数）。 */
export function lengthThreads(text: string): number {
  return Array.from(text).length;
}

export function measure(platform: Platform, text: string): number {
  return platform === 'x' ? weightedLengthX(text) : lengthThreads(text);
}

export function maxLength(platform: Platform): number {
  return platform === 'x' ? X_CONFIG.maxWeightedLength : THREADS_CONFIG.maxLength;
}

export type LengthCheck = {
  platform: Platform;
  length: number;
  max: number;
  ok: boolean;
  remaining: number;
};

export function checkLength(platform: Platform, text: string): LengthCheck {
  const length = measure(platform, text);
  const max = maxLength(platform);
  return { platform, length, max, ok: length <= max && text.trim().length > 0, remaining: max - length };
}
