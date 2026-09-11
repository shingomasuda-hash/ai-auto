import { query, queryOne } from './pool.ts';
import { recordAudit } from './audit.ts';
import type { KnowledgeItem, KnowledgeKind, KnowledgeState } from '../domain/knowledge.ts';

export type KnowledgeRow = {
  id: string;
  owner_id: string;
  source_key: string | null;
  kind: KnowledgeKind;
  state: KnowledgeState;
  title: string;
  body: string;
  source: string;
  created_at: Date;
};

export async function listKnowledge(ownerId: string, state?: KnowledgeState): Promise<KnowledgeRow[]> {
  return query<KnowledgeRow>(
    `SELECT * FROM knowledge
      WHERE owner_id = $1 AND ($2::text IS NULL OR state = $2)
      ORDER BY kind, created_at DESC`,
    [ownerId, state ?? null],
  );
}

export async function knowledgeMap(ownerId: string): Promise<Map<string, KnowledgeItem>> {
  const rows = await listKnowledge(ownerId);
  return new Map(rows.map((r) => [r.id, {
    id: r.id, kind: r.kind, state: r.state, title: r.title, body: r.body, source: r.source,
  }]));
}

export async function createKnowledge(
  ownerId: string,
  input: {
    kind: KnowledgeKind;
    title: string;
    body: string;
    source: string;
    /** 元データの識別子。同じ鍵で二度投入しない。 */
    sourceKey?: string | null;
    /** 本人が承認済みとして提供したものは APPROVED で入れる。 */
    state?: KnowledgeState;
  },
): Promise<KnowledgeRow> {
  const row = await queryOne<KnowledgeRow>(
    `INSERT INTO knowledge (owner_id, kind, title, body, source, source_key, state)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'DRAFT'))
     RETURNING *`,
    [ownerId, input.kind, input.title, input.body, input.source, input.sourceKey ?? null, input.state ?? null],
  );
  await recordAudit({
    ownerId, actor: 'owner', action: 'knowledge.create', targetType: 'knowledge', targetId: row!.id,
    detail: { kind: input.kind },
  });
  return row!;
}

/** 知識の承認は必ず管理者の操作。AIの出力から自動で行わない。 */
export async function setKnowledgeState(ownerId: string, id: string, state: KnowledgeState): Promise<KnowledgeRow | null> {
  const row = await queryOne<KnowledgeRow>(
    `UPDATE knowledge SET state = $3, updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId, state],
  );
  if (row) {
    await recordAudit({
      ownerId, actor: 'owner', action: 'knowledge.set_state', targetType: 'knowledge', targetId: id, detail: { state },
    });
  }
  return row;
}
