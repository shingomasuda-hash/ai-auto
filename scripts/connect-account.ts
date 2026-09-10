/**
 * 媒体の接続情報を登録する。
 *
 * トークンは引数に書かず、標準入力から読む（履歴に残さないため）。
 * 保存時は TOKEN_ENCRYPTION_KEY で暗号化し、画面には表示しない。
 *
 * 使い方:
 *   npm run account:connect -- <threads|x> <mode> [external_user_id]
 *     mode: disconnected | simulated | live
 *
 * live を指定した場合のみトークンを尋ねる。
 * simulated は外部へ一切送信しない（動作確認用）。
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { query, closePool } from '../src/db/pool.ts';
import { encryptSecret } from '../src/lib/crypto.ts';
import { recordAudit } from '../src/db/audit.ts';

const MODES = ['disconnected', 'simulated', 'live'] as const;

async function main(): Promise<void> {
  const [platform, mode, externalUserId] = process.argv.slice(2);

  if (platform !== 'threads' && platform !== 'x') {
    console.error('使い方: npm run account:connect -- <threads|x> <disconnected|simulated|live> [external_user_id]');
    process.exitCode = 1;
    return;
  }
  if (!(MODES as readonly string[]).includes(mode)) {
    console.error(`mode は ${MODES.join(' | ')} のいずれかです。`);
    process.exitCode = 1;
    return;
  }

  const owners = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users ORDER BY created_at LIMIT 1`,
  );
  if (owners.length === 0) {
    console.error('所有者がいません。先に `npm run admin:create -- <email>` を実行してください。');
    process.exitCode = 1;
    return;
  }
  const owner = owners[0];

  let accessTokenEnc: string | null = null;
  let refreshTokenEnc: string | null = null;

  if (mode === 'live') {
    if (!externalUserId) {
      console.error('live のときは external_user_id が必要です。');
      process.exitCode = 1;
      return;
    }
    if (!process.env.TOKEN_ENCRYPTION_KEY) {
      console.error('TOKEN_ENCRYPTION_KEY が設定されていません。');
      process.exitCode = 1;
      return;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const accessToken = (await rl.question('アクセストークン: ')).trim();
    const refreshToken = (await rl.question('リフレッシュトークン(なければ空): ')).trim();
    rl.close();
    if (accessToken === '') {
      console.error('アクセストークンが空です。');
      process.exitCode = 1;
      return;
    }
    accessTokenEnc = encryptSecret(accessToken);
    refreshTokenEnc = refreshToken === '' ? null : encryptSecret(refreshToken);
  }

  await query(
    `INSERT INTO accounts (owner_id, platform, connection_mode, external_user_id, access_token_enc, refresh_token_enc, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (owner_id, platform) DO UPDATE
       SET connection_mode = EXCLUDED.connection_mode,
           external_user_id = COALESCE(EXCLUDED.external_user_id, accounts.external_user_id),
           access_token_enc = COALESCE(EXCLUDED.access_token_enc, accounts.access_token_enc),
           refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, accounts.refresh_token_enc),
           last_error = NULL,
           updated_at = now()`,
    [owner.id, platform, mode, externalUserId ?? null, accessTokenEnc, refreshTokenEnc],
  );

  await recordAudit({
    ownerId: owner.id, actor: 'owner', action: 'account.connect',
    targetType: 'account', targetId: platform, detail: { mode },
  });

  console.log(`${platform} を ${mode} に設定しました。(所有者: ${owner.email})`);
  if (mode === 'live') {
    console.log('注意: 設定画面の停止フラグを解除するまで、実際の送信は行われません。');
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  main()
    .then(() => closePool())
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      await closePool();
      process.exitCode = 1;
    });
}
