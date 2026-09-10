import { NextResponse } from 'next/server';
import { withOwner, badRequest } from '../../../../../lib/api.ts';
import { approveVariant } from '../../../../../db/posts.ts';

type Params = { params: Promise<{ id: string }> };

export const POST = withOwner<Params>(async (user, _request, context) => {
  const { id } = await context.params;
  const result = await approveVariant(user.id, id);
  if (!result.ok) return badRequest(result.errors);
  return NextResponse.json({ state: result.variant.state, message: '承認しました。' });
});
