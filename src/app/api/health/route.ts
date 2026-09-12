import { NextResponse } from 'next/server';
import { getSetupStatus } from '../../../db/health.ts';
import { getCurrentUser } from '../../../lib/session.ts';

export const dynamic = 'force-dynamic';

/**
 * 環境の状態を返す。
 *
 * 所有者がまだ1件も無い「初期設定中」のあいだだけ詳細を返す。
 * 所有者ができたあとはログインを必須にする。
 * （所有者が作れないうちは誰もログインできないので、その間だけ開ける）
 *
 * 返すのは設定の有無・件数・真偽値だけで、値は一切返さない。
 */
export async function GET(): Promise<NextResponse> {
  const status = await getSetupStatus();

  if (status.ownerExists) {
    const user = await getCurrentUser();
    if (!user) {
      // 設定が済んでいるなら、状態は所有者にしか見せない。
      return NextResponse.json({ ok: true }, { status: 200 });
    }
  }

  return NextResponse.json({
    setupComplete: status.databaseReachable && status.migrationsApplied > 0 && status.ownerExists,
    databaseReachable: status.databaseReachable,
    migrationsApplied: status.migrationsApplied,
    ownerExists: status.ownerExists,
    env: status.env,
    nextSteps: status.nextSteps,
  });
}
