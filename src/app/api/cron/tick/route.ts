import { NextResponse } from 'next/server';
import { authorizeCron } from '../../../../lib/cron-auth.ts';
import { runTick, defaultTickOptions } from '../../../../worker/tick.ts';

export const dynamic = 'force-dynamic';

/**
 * 実行時間の上限（秒）。
 * Vercel の既定は10秒。ここで伸ばしても、runTick 側の budget が
 * それより短く自制するので、途中で殺されないようにしてある。
 */
export const maxDuration = 60;

/**
 * cron から叩く入口。
 *
 * 予約投稿の送信、期限切れの処理、結果不明の照合、指標の取得を
 * 1巡ぶんだけ行う。時間と件数の上限で区切るので、残りがあれば
 * 次の起動で拾う。取りこぼしにはならない。
 *
 * Vercel の cron は GET で叩くため GET を受ける。外部のcronサービス
 * から POST で叩いてもよい。どちらも CRON_SECRET で認可する。
 */
async function handle(request: Request): Promise<NextResponse> {
  const auth = authorizeCron(request.headers);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  const workerId = process.env.WORKER_ID ?? 'cron';
  const started = Date.now();

  try {
    const summary = await runTick({ workerId, ...defaultTickOptions() });
    // 何をしたかは残す。誰が叩いても同じ結果が返る必要はない。
    console.log('[cron] tick', JSON.stringify(summary));
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    console.error('[cron] tick failed', error);
    return NextResponse.json(
      { ok: false, error: '処理中にエラーが発生しました。', durationMs: Date.now() - started },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
