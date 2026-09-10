import { NextResponse } from 'next/server';
import { withOwner, readJson, str, badRequest } from '../../../../lib/api.ts';
import { setKnowledgeState } from '../../../../db/knowledge.ts';

type Params = { params: Promise<{ id: string }> };

export const POST = withOwner<Params>(async (user, request, context) => {
  const { id } = await context.params;
  const payload = await readJson(request);
  const state = str(payload.state);
  if (!['DRAFT', 'APPROVED', 'ARCHIVED'].includes(state)) return badRequest(['状態が不正です。']);

  const row = await setKnowledgeState(user.id, id, state as 'DRAFT' | 'APPROVED' | 'ARCHIVED');
  if (!row) return badRequest(['知識が見つかりません。']);
  return NextResponse.json({ state: row.state });
});
