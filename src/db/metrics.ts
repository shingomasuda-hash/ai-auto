import { query } from './pool.ts';
import { recordAudit } from './audit.ts';
import type { Snapshot } from '../domain/metrics.ts';
import type { ProposalState, ImprovementProposal } from '../domain/proposal.ts';

export type SnapshotRow = {
  id: string;
  variant_id: string;
  published_at: Date;
  captured_at: Date;
  elapsed_bucket_hours: number | null;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  link_clicks: number | null;
};

/** 公開済み投稿のスナップショットを読む。欠測は NULL のまま返す。 */
export async function listSnapshots(ownerId: string): Promise<Snapshot[]> {
  const rows = await query<SnapshotRow>(
    `SELECT s.id, s.variant_id, v.published_at, s.captured_at, s.elapsed_bucket_hours,
            s.impressions, s.likes, s.replies, s.reposts, s.link_clicks
       FROM metric_snapshots s
       JOIN post_variants v ON v.id = s.variant_id
      WHERE s.owner_id = $1 AND v.published_at IS NOT NULL
      ORDER BY s.captured_at DESC`,
    [ownerId],
  );
  return rows.map((row) => ({
    postId: row.variant_id,
    publishedAt: row.published_at,
    capturedAt: row.captured_at,
    values: {
      impressions: row.impressions,
      likes: row.likes,
      replies: row.replies,
      reposts: row.reposts,
      linkClicks: row.link_clicks,
    },
  }));
}

export type ProposalRow = {
  id: string;
  state: ProposalState;
  observations: string[];
  hypotheses: string[];
  changes: string[];
  evidence_ids: string[];
  cautions: string[];
  created_at: Date;
  decided_at: Date | null;
  decided_note: string | null;
};

export async function listProposals(ownerId: string): Promise<ProposalRow[]> {
  return query<ProposalRow>(
    `SELECT id, state, observations, hypotheses, changes, evidence_ids, cautions,
            created_at, decided_at, decided_note
       FROM improvement_proposals
      WHERE owner_id = $1
      ORDER BY (state = 'PENDING') DESC, created_at DESC`,
    [ownerId],
  );
}

export async function createProposal(ownerId: string, proposal: ImprovementProposal): Promise<ProposalRow> {
  const rows = await query<ProposalRow>(
    `INSERT INTO improvement_proposals
       (owner_id, observations, hypotheses, changes, evidence_ids, cautions)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)
     RETURNING id, state, observations, hypotheses, changes, evidence_ids, cautions,
               created_at, decided_at, decided_note`,
    [
      ownerId,
      JSON.stringify(proposal.observations),
      JSON.stringify(proposal.hypotheses),
      JSON.stringify(proposal.changes),
      JSON.stringify(proposal.evidenceIds),
      JSON.stringify(proposal.cautions),
    ],
  );
  return rows[0];
}

/** 提案の採否は必ず管理者が決める。自動適用の経路を作らない。 */
export async function decideProposal(
  ownerId: string,
  id: string,
  state: 'ACCEPTED' | 'REJECTED',
  note: string,
): Promise<ProposalRow | null> {
  const rows = await query<ProposalRow>(
    `UPDATE improvement_proposals
        SET state = $3, decided_at = now(), decided_note = $4
      WHERE id = $1 AND owner_id = $2 AND state = 'PENDING'
      RETURNING id, state, observations, hypotheses, changes, evidence_ids, cautions,
                created_at, decided_at, decided_note`,
    [id, ownerId, state, note],
  );
  if (rows[0]) {
    await recordAudit({
      ownerId, actor: 'owner', action: 'proposal.decide', targetType: 'proposal', targetId: id, detail: { state },
    });
  }
  return rows[0] ?? null;
}

export async function clicksByVariant(ownerId: string): Promise<Map<string, number>> {
  const rows = await query<{ variant_id: string | null; count: string }>(
    `SELECT variant_id, count(*)::text AS count
       FROM click_events WHERE owner_id = $1 GROUP BY variant_id`,
    [ownerId],
  );
  const map = new Map<string, number>();
  for (const row of rows) if (row.variant_id) map.set(row.variant_id, Number(row.count));
  return map;
}
