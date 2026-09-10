import { NextResponse } from 'next/server';
import { withOwner, readJson, str, badRequest } from '../../../../../lib/api.ts';
import { scheduleVariant } from '../../../../../db/posts.ts';
import { parseJstLocalInput, formatJst } from '../../../../../domain/time.ts';

type Params = { params: Promise<{ id: string }> };

export const POST = withOwner<Params>(async (user, request, context) => {
  const { id } = await context.params;
  const payload = await readJson(request);

  // 画面からはJSTの壁時計で受け取り、UTCへ変換して保存する。
  let at: Date;
  try {
    at = parseJstLocalInput(str(payload.scheduledAt));
  } catch {
    return badRequest(['予約日時の形式が不正です。']);
  }

  const result = await scheduleVariant(user.id, id, at, {
    allowDuplicate: payload.allowDuplicate === true,
  });
  if (!result.ok) return badRequest(result.errors);
  return NextResponse.json({
    state: result.variant.state,
    scheduledAt: result.variant.scheduled_at,
    message: `${formatJst(at)} に予約しました。`,
  });
});
