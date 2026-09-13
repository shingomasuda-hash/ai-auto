/**
 * 所有者のパスワードを変更する。
 *
 * 使い方: npm run admin:password -- <email>
 * 新しいパスワードは標準入力から読む（引数に書かない・画面へ出さない）。
 *
 * 変更すると、その所有者の既存セッションはすべて無効になる。
 * 漏れたパスワードで開いたままの画面を残さないため。
 */
import path from 'node:path';
import { query, queryOne, withTransaction, closePool } from '../src/db/pool.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { recordAudit } from '../src/db/audit.ts';
import { createPrompter } from '../src/lib/prompt.ts';

export async function changePassword(email: string, password: string): Promise<{ userId: string; sessionsRevoked: number }> {
  const user = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  if (!user) throw new Error(`所有者が見つかりません: ${email}`);

  const passwordHash = await hashPassword(password);

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
      [user.id, passwordHash],
    );
    // 変更前のパスワードで作られたセッションを残さない。
    const { rows } = await client.query<{ count: string }>(
      `WITH deleted AS (DELETE FROM sessions WHERE user_id = $1 RETURNING 1)
       SELECT count(*)::text AS count FROM deleted`,
      [user.id],
    );
    await recordAudit(
      { ownerId: user.id, actor: 'owner', action: 'auth.password_changed' },
      client,
    );
    return { userId: user.id, sessionsRevoked: Number(rows[0].count) };
  });
}

async function main(): Promise<void> {
  const [email] = process.argv.slice(2);
  if (!email) {
    console.error('使い方: npm run admin:password -- <email>');
    process.exitCode = 1;
    return;
  }

  const exists = await query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [email.trim()]);
  if (exists.length === 0) {
    console.error(`所有者が見つかりません: ${email}`);
    process.exitCode = 1;
    return;
  }

  const prompter = await createPrompter();
  let password: string;
  let confirm: string;
  try {
    password = await prompter.askSecret('新しいパスワード(12文字以上)');
    confirm = await prompter.askSecret('もう一度');
  } finally {
    prompter.close();
  }

  if (password !== confirm) {
    console.error('パスワードが一致しません。変更していません。');
    process.exitCode = 1;
    return;
  }

  const result = await changePassword(email, password);
  console.log(`パスワードを変更しました: ${email}`);
  if (result.sessionsRevoked > 0) {
    console.log(`ログイン中のセッション ${result.sessionsRevoked} 件を無効にしました。再ログインが必要です。`);
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
