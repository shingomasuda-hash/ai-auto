import type { PoolClient } from 'pg';
import { getPool, withTransaction } from './pool.ts';
import { POLICY } from '../domain/policy.ts';

export type JobKind = 'publish' | 'collect_metrics' | 'reconcile' | 'email_step';
export type JobState = 'READY' | 'CLAIMED' | 'DONE' | 'FAILED' | 'CANCELLED';

export type Job = {
  id: string;
  owner_id: string;
  kind: JobKind;
  ref_id: string;
  state: JobState;
  run_after: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  attempts: number;
  last_error: string | null;
};

/**
 * ジョブを登録する。同じ対象の未完了ジョブがあれば作らない
 * (jobs_active_ref_key の部分一意索引で担保)。
 */
export async function enqueueJob(
  input: { ownerId: string; kind: JobKind; refId: string; runAfter?: Date },
  client?: PoolClient,
): Promise<Job | null> {
  const runner = client ?? getPool();
  const { rows } = await runner.query<Job>(
    `INSERT INTO jobs (owner_id, kind, ref_id, run_after)
     VALUES ($1, $2, $3, COALESCE($4, now()))
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [input.ownerId, input.kind, input.refId, input.runAfter ?? null],
  );
  return rows[0] ?? null;
}

/**
 * ジョブを原子的に1件取得する。
 *
 * FOR UPDATE SKIP LOCKED により、並行するワーカーが同じ行を取得できない。
 * claim には必ず期限(claim_expires_at)を付ける。
 */
export async function claimJob(
  workerId: string,
  options: { kinds?: JobKind[]; leaseMs?: number; now?: Date } = {},
): Promise<Job | null> {
  const leaseMs = options.leaseMs ?? POLICY.claimLeaseMs;
  const kinds = options.kinds ?? null;
  const { rows } = await getPool().query<Job>(
    `UPDATE jobs
        SET state = 'CLAIMED',
            claimed_by = $1,
            claimed_at = now(),
            claim_expires_at = now() + ($2 || ' milliseconds')::interval,
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = (
        SELECT id FROM jobs
         WHERE state = 'READY'
           AND run_after <= now()
           AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
         ORDER BY run_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [workerId, String(leaseMs), kinds],
  );
  return rows[0] ?? null;
}

export async function finishJob(
  jobId: string,
  state: 'DONE' | 'FAILED' | 'CANCELLED',
  lastError: string | null = null,
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? getPool();
  await runner.query(
    `UPDATE jobs
        SET state = $2, last_error = $3, claimed_by = NULL, claimed_at = NULL,
            claim_expires_at = NULL, updated_at = now()
      WHERE id = $1`,
    [jobId, state, lastError],
  );
}

/** 送信前のジョブを安全に READY へ戻す(外部未送信のときだけ使う)。 */
export async function releaseJob(jobId: string, runAfter: Date | null = null, client?: PoolClient): Promise<void> {
  const runner = client ?? getPool();
  await runner.query(
    `UPDATE jobs
        SET state = 'READY', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
            run_after = COALESCE($2, run_after), updated_at = now()
      WHERE id = $1`,
    [jobId, runAfter],
  );
}

export type SweepResult = {
  /** 外部未送信が確実なので READY へ戻したジョブ。 */
  released: string[];
  /** 送信済みかもしれないので UNKNOWN へ隔離した variant。 */
  quarantined: { jobId: string; variantId: string }[];
};

/**
 * リース期限が切れた claim を回収する。
 *
 * 重要: 「送信を開始していたか」で扱いを変える。
 *  - CLAIMED のまま(= attempt を作る前) → 外部へ送っていないので READY へ戻す。
 *  - PUBLISHING(= 送信を開始済み) → 送信済みかどうか分からないので再送しない。
 *    variant を UNKNOWN へ隔離し、外部の公開状態を照合する reconcile ジョブを積む。
 */
export async function sweepExpiredClaims(now: Date = new Date()): Promise<SweepResult> {
  return withTransaction(async (client) => {
    const { rows: expired } = await client.query<{ id: string; ref_id: string; kind: JobKind }>(
      `SELECT id, ref_id, kind
         FROM jobs
        WHERE state = 'CLAIMED' AND claim_expires_at IS NOT NULL AND claim_expires_at < $1
        FOR UPDATE SKIP LOCKED`,
      [now],
    );

    const result: SweepResult = { released: [], quarantined: [] };

    for (const job of expired) {
      if (job.kind !== 'publish') {
        // 送信を伴わないジョブは安全に戻せる。
        await releaseJob(job.id, null, client);
        result.released.push(job.id);
        continue;
      }

      const { rows: variants } = await client.query<{ id: string; state: string }>(
        `SELECT id, state FROM post_variants WHERE id = $1 FOR UPDATE`,
        [job.ref_id],
      );
      const variant = variants[0];
      if (!variant) {
        await finishJob(job.id, 'CANCELLED', 'variant not found', client);
        continue;
      }

      if (variant.state === 'PUBLISHING') {
        // 送信済みかどうか不明。再送せず隔離する。
        await client.query(
          `UPDATE post_variants
              SET state = 'UNKNOWN',
                  last_error = 'claim lease expired while publishing',
                  updated_at = now()
            WHERE id = $1`,
          [variant.id],
        );
        await finishJob(job.id, 'FAILED', 'lease expired during publish; quarantined as UNKNOWN', client);
        await enqueueJob({ ownerId: await ownerOfVariant(client, variant.id), kind: 'reconcile', refId: variant.id }, client);
        result.quarantined.push({ jobId: job.id, variantId: variant.id });
        continue;
      }

      if (variant.state === 'CLAIMED') {
        // まだ外部へ送っていない。予約状態へ戻して再取得できるようにする。
        await client.query(
          `UPDATE post_variants SET state = 'SCHEDULED', updated_at = now() WHERE id = $1`,
          [variant.id],
        );
        await releaseJob(job.id, null, client);
        result.released.push(job.id);
        continue;
      }

      // すでに決着している(PUBLISHED/FAILED/UNKNOWN/EXPIRED)ならジョブを閉じる。
      await finishJob(job.id, 'DONE', `variant already in ${variant.state}`, client);
    }

    return result;
  });
}

async function ownerOfVariant(client: PoolClient, variantId: string): Promise<string> {
  const { rows } = await client.query<{ owner_id: string }>(
    `SELECT owner_id FROM post_variants WHERE id = $1`,
    [variantId],
  );
  return rows[0].owner_id;
}

export async function countJobs(ownerId: string, state: JobState): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE owner_id = $1 AND state = $2`,
    [ownerId, state],
  );
  return Number(rows[0].count);
}
