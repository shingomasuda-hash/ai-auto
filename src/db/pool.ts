import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';

let pool: Pool | null = null;

/**
 * 同時接続数の既定値。
 *
 * サーバーレス(Vercel等)では関数の実例ごとにプールができるため、
 * 実例が増えるほど接続が増える。既定を大きくするとDB側の上限に当たる。
 * 常駐サーバーやコマンド実行では多めでよい。
 */
function defaultPoolMax(): number {
  const configured = process.env.DATABASE_POOL_MAX;
  if (configured !== undefined && configured !== '') {
    const value = Number(configured);
    if (Number.isInteger(value) && value > 0) return value;
  }
  // Vercel は関数の実例ごとに別プロセス。1実例あたり1接続に抑える。
  return process.env.VERCEL ? 1 : 10;
}

/**
 * SSLの扱い。
 *
 * DATABASE_SSL=require なら証明書を検証する。
 * 未設定なら接続文字列の sslmode に任せる（Neon 等は sslmode=require を含む）。
 */
function sslOption(): { rejectUnauthorized: boolean } | undefined {
  if (process.env.DATABASE_SSL === 'require') return { rejectUnauthorized: true };
  return undefined;
}

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL が設定されていません。.env.example を参照してください。');
  }
  pool = new Pool({
    connectionString,
    max: defaultPoolMax(),
    ssl: sslOption(),
    // 接続できないまま待ち続けない。設定ミスを早く気づけるようにする。
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000),
    // 使われていない接続を抱えたままにしない（スケールしてゼロになるDB向け）。
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 10_000),
  });
  // プール内の接続が落ちてもプロセスを落とさない。
  pool.on('error', (error) => {
    console.error('[db] idle client error', error.message);
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** トランザクション。例外時は必ずロールバックする。 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ロールバック自体の失敗は元の例外を隠さない。
    }
    throw error;
  } finally {
    client.release();
  }
}
