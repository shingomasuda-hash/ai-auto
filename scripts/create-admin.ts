/**
 * 所有者アカウントを作成する。
 * 使い方: npm run admin:create -- <email> <displayName>
 * パスワードは標準入力から読む（引数に書かない）。
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createUser } from '../src/db/auth.ts';
import { closePool } from '../src/db/pool.ts';
import { ensureEnvelopes } from '../src/db/budget.ts';
import { jstMonthKey } from '../src/domain/time.ts';

async function main(): Promise<void> {
  const [email, displayName] = process.argv.slice(2);
  if (!email) {
    console.error('使い方: npm run admin:create -- <email> [表示名]');
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const password = await rl.question('パスワード(12文字以上): ');
  const confirm = await rl.question('もう一度: ');
  rl.close();

  if (password !== confirm) {
    console.error('パスワードが一致しません。');
    process.exitCode = 1;
    return;
  }

  const user = await createUser(email, password, displayName ?? '');
  await ensureEnvelopes(user.id, jstMonthKey(new Date()));
  console.log(`作成しました: ${user.email} (${user.id})`);
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closePool();
    process.exitCode = 1;
  });
