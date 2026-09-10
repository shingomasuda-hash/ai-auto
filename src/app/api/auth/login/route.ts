import { NextResponse } from 'next/server';
import { authenticate, createSession, SESSION_COOKIE, SESSION_TTL_MS } from '../../../../db/auth.ts';
import { recordAudit } from '../../../../db/audit.ts';
import { readJson, str } from '../../../../lib/api.ts';

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJson(request);
  const email = str(body.email);
  const password = str(body.password);

  if (!email || !password) {
    return NextResponse.json({ error: 'メールアドレスとパスワードを入力してください。' }, { status: 400 });
  }

  const user = await authenticate(email, password);
  if (!user) {
    // 存在しないのか、パスワードが違うのかを区別しない。
    await recordAudit({ ownerId: null, actor: 'anonymous', action: 'auth.login_failed', detail: { email } });
    return NextResponse.json({ error: 'メールアドレスかパスワードが正しくありません。' }, { status: 401 });
  }

  const { token } = await createSession(user.id, request.headers.get('user-agent'));
  await recordAudit({ ownerId: user.id, actor: 'owner', action: 'auth.login' });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return response;
}
