import { NextResponse } from 'next/server';
import { authenticate, createSession, SESSION_COOKIE, SESSION_TTL_MS } from '../../../../db/auth.ts';
import { recordAudit } from '../../../../db/audit.ts';
import { readJson, str } from '../../../../lib/api.ts';
import { getSetupStatus } from '../../../../db/health.ts';

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readJson(request);
  const email = str(body.email);
  const password = str(body.password);

  if (!email || !password) {
    return NextResponse.json({ error: 'メールアドレスとパスワードを入力してください。' }, { status: 400 });
  }

  let user;
  try {
    user = await authenticate(email, password);
  } catch (error) {
    // DBへ繋がらない・マイグレーション未適用などは、認証の失敗とは別物。
    // 「パスワードが違う」と表示すると原因を探せなくなる。
    console.error('[auth] login failed before authentication', error);
    const status = await getSetupStatus().catch(() => null);
    const reason = status?.nextSteps[0] ?? 'データベースへ接続できません。';
    return NextResponse.json(
      { error: `ログインの前段で失敗しました。${reason}`, setupIssue: true },
      { status: 503 },
    );
  }

  if (!user) {
    // 存在しないのか、パスワードが違うのかは区別しない。
    // ただし所有者が1件も無いなら、それは設定の問題なので伝える。
    await recordAudit({ ownerId: null, actor: 'anonymous', action: 'auth.login_failed', detail: { email } })
      .catch(() => {});
    const status = await getSetupStatus().catch(() => null);
    if (status && !status.ownerExists) {
      return NextResponse.json(
        {
          error: '所有者アカウントがまだ作成されていません。`npm run admin:create -- <email>` で作成してください。',
          setupIssue: true,
        },
        { status: 503 },
      );
    }
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
