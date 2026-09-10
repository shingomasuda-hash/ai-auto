import { query, queryOne, withTransaction } from './pool.ts';
import { hashPassword, verifyPassword, generateToken, hashToken } from '../lib/crypto.ts';

export const SESSION_COOKIE = 'aiops_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type User = {
  id: string;
  email: string;
  display_name: string;
  role: 'owner';
};

export async function createUser(email: string, password: string, displayName: string): Promise<User> {
  const passwordHash = await hashPassword(password);
  return withTransaction(async (client) => {
    const { rows } = await client.query<User>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, role`,
      [email.trim(), passwordHash, displayName],
    );
    const user = rows[0];
    // 所有者ごとの設定行を必ず作る。初期はすべて停止・AI無効。
    await client.query(`INSERT INTO settings (owner_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user.id]);
    for (const platform of ['threads', 'x']) {
      await client.query(
        `INSERT INTO accounts (owner_id, platform) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [user.id, platform],
      );
    }
    return user;
  });
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const row = await queryOne<User & { password_hash: string }>(
    `SELECT id, email, display_name, role, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  // 存在しない場合もハッシュ検証にかかる時間を揃え、列挙を防ぐ。
  const stored = row?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, stored);
  if (!row || !ok) return null;
  return { id: row.id, email: row.email, display_name: row.display_name, role: row.role };
}

/** セッションを作る。戻り値の平文トークンはCookieにだけ入れる。 */
export async function createSession(userId: string, userAgent: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
    [hashToken(token), userId, expiresAt, userAgent],
  );
  return { token, expiresAt };
}

export async function findUserBySessionToken(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  return queryOne<User>(
    `SELECT u.id, u.email, u.display_name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function purgeExpiredSessions(): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH deleted AS (DELETE FROM sessions WHERE expires_at <= now() RETURNING 1)
     SELECT count(*)::text AS count FROM deleted`,
  );
  return Number(rows[0]?.count ?? 0);
}
