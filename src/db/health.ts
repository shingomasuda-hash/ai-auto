import { getPool } from './pool.ts';

export type SetupStatus = {
  /** DBへ接続できたか。 */
  databaseReachable: boolean;
  /** 適用済みマイグレーションの数。0 なら未適用。 */
  migrationsApplied: number;
  /** 所有者が1件以上いるか。false ならログインできない（作成が必要）。 */
  ownerExists: boolean;
  /** 環境変数の設定有無。値は返さない。 */
  env: Record<string, boolean>;
  /** 次にやること。 */
  nextSteps: string[];
};

const REQUIRED_ENV = ['DATABASE_URL', 'TOKEN_ENCRYPTION_KEY'] as const;
const OPTIONAL_ENV = [
  'DATABASE_SSL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'AI_PRICE_INPUT_PER_MTOK', 'AI_PRICE_OUTPUT_PER_MTOK', 'AI_PRICE_CURRENCY', 'AI_FX_RATE_TO_JPY',
  'THREADS_APP_ID', 'X_CLIENT_ID', 'CRON_SECRET',
] as const;

/**
 * 環境の状態を調べる。**値は一切返さず、設定の有無だけを返す。**
 *
 * デプロイ直後に「DBに繋がっていない」のか「アカウントが無いだけ」なのかを
 * 区別できるようにするためのもの。
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  const env: Record<string, boolean> = {};
  for (const name of [...REQUIRED_ENV, ...OPTIONAL_ENV]) {
    env[name] = typeof process.env[name] === 'string' && process.env[name] !== '';
  }

  const status: SetupStatus = {
    databaseReachable: false,
    migrationsApplied: 0,
    ownerExists: false,
    env,
    nextSteps: [],
  };

  if (!env.DATABASE_URL) {
    status.nextSteps.push('DATABASE_URL を設定してください。');
    return status;
  }

  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    status.databaseReachable = true;

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
    );
    if (Number(rows[0].count) > 0) {
      const applied = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM schema_migrations`,
      );
      status.migrationsApplied = Number(applied.rows[0].count);
    }

    if (status.migrationsApplied > 0) {
      const owners = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users`);
      status.ownerExists = Number(owners.rows[0].count) > 0;
    }
  } catch {
    // 接続できない理由の詳細は外に出さない。
    status.nextSteps.push('DBへ接続できません。DATABASE_URL と DATABASE_SSL を確認してください。');
    return status;
  }

  if (status.migrationsApplied === 0) {
    status.nextSteps.push('マイグレーションが未適用です。`npm run migrate` を実行してください。');
  } else if (!status.ownerExists) {
    status.nextSteps.push('所有者が未作成です。`npm run admin:create -- <email>` を実行してください。');
  }
  if (!env.TOKEN_ENCRYPTION_KEY) {
    status.nextSteps.push('TOKEN_ENCRYPTION_KEY が未設定です。媒体の接続に必要です。');
  }
  if (status.nextSteps.length === 0) {
    status.nextSteps.push('ログインできます。');
  }
  return status;
}
