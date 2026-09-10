import type { PoolClient } from 'pg';
import { getPool } from './pool.ts';

export async function recordAudit(
  input: {
    ownerId: string | null;
    actor: string;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: Record<string, unknown>;
  },
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? getPool();
  await runner.query(
    `INSERT INTO audit_logs (owner_id, actor, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.ownerId,
      input.actor,
      input.action,
      input.targetType ?? '',
      input.targetId ?? '',
      JSON.stringify(input.detail ?? {}),
    ],
  );
}
