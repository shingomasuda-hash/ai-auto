/**
 * ワーカーのループ。
 *
 * 新旧のスケジューラーを同時に起動しないこと。
 * 起動中のワーカーは WORKER_ID で識別される。同じIDを複数起動しない。
 *
 * 使い方:
 *   npm run worker              -- 常駐して処理する
 *   npm run worker -- --once    -- 1巡だけ処理して終了する（cron向け）
 */
import path from 'node:path';
import { closePool } from '../src/db/pool.ts';
import { runTick, defaultTickOptions, didWork } from '../src/worker/tick.ts';
import { purgeExpiredSessions } from '../src/db/auth.ts';

const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const IDLE_DELAY_MS = 5_000;

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} を受け取りました。処理中のものを終えて停止します。`);
    controller.abort();
  });
}

/** 1巡ぶんの処理。何か処理したら true。 */
export async function tick(): Promise<boolean> {
  const summary = await runTick({
    workerId: WORKER_ID,
    signal: controller.signal,
    ...defaultTickOptions(),
    onEvent: (kind, detail) => console.log(`${kind}: ${JSON.stringify(detail)}`),
  });
  if (summary.budgetExhausted) {
    console.log('上限に達したため途中で戻りました。残りは次の巡回で処理します。');
  }
  return didWork(summary);
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  console.log(`ワーカーを開始します (id=${WORKER_ID}, mode=${once ? 'once' : 'loop'})`);

  if (once) {
    await tick();
    await purgeExpiredSessions();
    return;
  }

  while (!controller.signal.aborted) {
    try {
      const didWork = await tick();
      if (!didWork) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
      }
    } catch (error) {
      console.error('ループでエラーが発生しました:', error);
      await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
    }
  }
  console.log('停止しました。');
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  main()
    .then(() => closePool())
    .catch(async (error) => {
      console.error(error);
      await closePool();
      process.exitCode = 1;
    });
}
