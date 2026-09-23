import type { PoolClient } from 'pg';
import { getPool, withTransaction } from './pool.ts';
import { POLICY } from '../domain/policy.ts';
import type { Platform } from '../domain/text-length.ts';

export type SlotReservation =
  | { ok: true; reservationId: string }
  | { ok: false; code: 'rate_limited' | 'min_interval'; message: string; retryAt: Date };

/**
 * 送信枠を原子的に取る。
 *
 * 媒体ごとのアンカー行を FOR UPDATE でロックしてから数えるので、
 * 同時に走っている別のワーカーは待たされ、両方が通ることはない。
 *
 * ロックは枠を記録した時点で解放する。外部への送信はロックの外で行う。
 * 通信のあいだロックを握り続けると、接続と枠を長時間塞いでしまう。
 *
 * **枠は送信の成否に関わらず消費する。** 送ったかどうか分からない
 * 結果がありうる以上、控えめに倒す。
 */
export async function reserveSendSlot(
  ownerId: string,
  platform: Platform,
  variantId: string,
  now: Date = new Date(),
): Promise<SlotReservation> {
  return withTransaction(async (client) => {
    await lockAnchor(client, ownerId, platform);

    const windowStart = new Date(now.getTime() - POLICY.rateWindowMs);
    const { rows } = await client.query<{ reserved_at: Date }>(
      `SELECT reserved_at FROM send_slot_reservations
        WHERE owner_id = $1 AND platform = $2 AND reserved_at > $3
        ORDER BY reserved_at DESC`,
      [ownerId, platform, windowStart],
    );

    if (rows.length >= POLICY.maxPostsPerPlatformPer24h) {
      // 窓から最も古い1件が抜ける時刻まで待つ。
      const oldest = rows[rows.length - 1].reserved_at;
      return {
        ok: false as const,
        code: 'rate_limited' as const,
        message: `直近24時間の${platform}の送信が${rows.length}件です。運営上限は${POLICY.maxPostsPerPlatformPer24h}件です。`,
        retryAt: new Date(oldest.getTime() + POLICY.rateWindowMs),
      };
    }

    const latest = rows[0]?.reserved_at;
    if (latest && now.getTime() - latest.getTime() < POLICY.minIntervalMs) {
      return {
        ok: false as const,
        code: 'min_interval' as const,
        message: `直前の${platform}送信から${POLICY.minIntervalMs / 3_600_000}時間経っていません。`,
        retryAt: new Date(latest.getTime() + POLICY.minIntervalMs),
      };
    }

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO send_slot_reservations (owner_id, platform, variant_id, reserved_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ownerId, platform, variantId, now],
    );
    return { ok: true as const, reservationId: inserted[0].id };
  });
}

/** 媒体ごとのアンカー行をロックする。無ければ作る。 */
async function lockAnchor(client: PoolClient, ownerId: string, platform: Platform): Promise<void> {
  await client.query(
    `INSERT INTO send_slot_anchors (owner_id, platform) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ownerId, platform],
  );
  await client.query(
    `SELECT 1 FROM send_slot_anchors WHERE owner_id = $1 AND platform = $2 FOR UPDATE`,
    [ownerId, platform],
  );
}

/**
 * 枠を返す。**外部へ届いていないことが確実な場合にだけ**使う。
 * 結果が不明なときは返さない。
 */
export async function releaseSendSlot(reservationId: string): Promise<void> {
  await getPool().query(`DELETE FROM send_slot_reservations WHERE id = $1`, [reservationId]);
}

/** 直近の窓で使った枠の数。画面の表示に使う。 */
export async function countRecentSlots(
  ownerId: string,
  platform: Platform,
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM send_slot_reservations
      WHERE owner_id = $1 AND platform = $2 AND reserved_at > $3`,
    [ownerId, platform, new Date(now.getTime() - POLICY.rateWindowMs)],
  );
  return Number(rows[0].count);
}
