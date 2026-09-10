import { NextResponse } from 'next/server';
import { withOwner, readJson, str, badRequest } from '../../../../lib/api.ts';
import { decideProposal } from '../../../../db/metrics.ts';

type Params = { params: Promise<{ id: string }> };

export const POST = withOwner<Params>(async (user, request, context) => {
  const { id } = await context.params;
  const payload = await readJson(request);
  const state = str(payload.state);
  if (state !== 'ACCEPTED' && state !== 'REJECTED') return badRequest(['採用か却下を指定してください。']);

  const result = await decideProposal(user.id, id, state, str(payload.note));
  if (!result) return badRequest(['提案が見つからないか、すでに判断済みです。']);
  return NextResponse.json({ state: result.state });
});
