/**
 * cron から叩く入口の認可。
 *
 * 失敗したら必ず閉じる。CRON_SECRET が未設定なら、誰にも通さない。
 * 「設定し忘れたので素通し」は、投稿を誰でも走らせられる穴になる。
 */

import { safeEqual } from './crypto.ts';

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string };

/**
 * Vercel の cron は `Authorization: Bearer <CRON_SECRET>` を送る。
 * 外部のcronサービスは Authorization を付けられないことがあるので、
 * `x-cron-secret` も受ける。どちらも定数時間で比較する。
 */
export function authorizeCron(headers: Headers): CronAuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    return {
      ok: false,
      status: 503,
      reason: 'CRON_SECRET が未設定です（16文字以上必要）。設定するまでこの入口は動きません。',
    };
  }

  const bearer = headers.get('authorization');
  const presented = bearer?.startsWith('Bearer ')
    ? bearer.slice('Bearer '.length)
    : headers.get('x-cron-secret');

  if (!presented || !safeEqual(presented, secret)) {
    return { ok: false, status: 401, reason: '認可されていません。' };
  }
  return { ok: true };
}
