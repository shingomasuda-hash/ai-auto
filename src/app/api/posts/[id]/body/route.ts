import { NextResponse } from 'next/server';
import { withOwner, readJson, str, badRequest } from '../../../../../lib/api.ts';
import { updateVariantBody } from '../../../../../db/posts.ts';

type Params = { params: Promise<{ id: string }> };

export const POST = withOwner<Params>(async (user, request, context) => {
  const { id } = await context.params;
  const payload = await readJson(request);
  const body = str(payload.body);
  if (body.trim() === '') return badRequest(['本文が空です。']);

  const result = await updateVariantBody(user.id, id, body);
  if (!result.ok) return badRequest(result.errors);
  return NextResponse.json({
    state: result.variant.state,
    reapprovalRequired: result.reapprovalRequired,
    message: result.reapprovalRequired
      ? '本文を保存しました。承認が取り消されたため、再承認が必要です。'
      : '本文を保存しました。',
  });
});
