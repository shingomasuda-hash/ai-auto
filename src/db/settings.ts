import { query, queryOne } from './pool.ts';
import { recordAudit } from './audit.ts';
import type { Platform } from '../domain/text-length.ts';

export type SettingsRow = {
  owner_id: string;
  global_stop: boolean;
  threads_stop: boolean;
  x_stop: boolean;
  email_stop: boolean;
  ai_generation_enabled: boolean;
  auto_approve_enabled: boolean;
  ai_model: string;
  monthly_budget_yen: number;
  monthly_goal_yen: number;
  email_test_mode: boolean;
  allowed_test_recipients: string[];
  sales_page_url: string | null;
  free_material_url: string | null;
};

export type AccountRow = {
  id: string;
  platform: Platform;
  connection_mode: 'disconnected' | 'simulated' | 'live';
  display_name: string;
  external_user_id: string | null;
  token_expires_at: Date | null;
  scopes: string[];
  last_error: string | null;
  /** トークンが保存されているかどうかだけを返す。値そのものは返さない。 */
  has_access_token: boolean;
  has_refresh_token: boolean;
};

export async function getSettings(ownerId: string): Promise<SettingsRow> {
  const row = await queryOne<SettingsRow>(`SELECT * FROM settings WHERE owner_id = $1`, [ownerId]);
  if (row) return row;
  const created = await queryOne<SettingsRow>(
    `INSERT INTO settings (owner_id) VALUES ($1) RETURNING *`, [ownerId],
  );
  return created!;
}

const UPDATABLE = [
  'global_stop', 'threads_stop', 'x_stop', 'email_stop',
  'ai_generation_enabled', 'auto_approve_enabled', 'ai_model',
  'monthly_budget_yen', 'monthly_goal_yen', 'email_test_mode', 'allowed_test_recipients',
  'sales_page_url', 'free_material_url',
] as const;

export async function updateSettings(
  ownerId: string,
  patch: Partial<Record<(typeof UPDATABLE)[number], unknown>>,
): Promise<SettingsRow> {
  const fields: string[] = [];
  const values: unknown[] = [ownerId];
  for (const key of UPDATABLE) {
    if (!(key in patch) || patch[key] === undefined) continue;
    values.push(patch[key]);
    fields.push(`${key} = $${values.length}`);
  }
  if (fields.length === 0) return getSettings(ownerId);

  const row = await queryOne<SettingsRow>(
    `UPDATE settings SET ${fields.join(', ')}, updated_at = now() WHERE owner_id = $1 RETURNING *`,
    values,
  );
  await recordAudit({ ownerId, actor: 'owner', action: 'settings.update', detail: { fields: Object.keys(patch) } });
  return row!;
}

/** 媒体の接続状態。トークンの値は絶対に返さない。 */
export async function listAccounts(ownerId: string): Promise<AccountRow[]> {
  return query<AccountRow>(
    `SELECT id, platform, connection_mode, display_name, external_user_id,
            token_expires_at, scopes, last_error,
            (access_token_enc IS NOT NULL) AS has_access_token,
            (refresh_token_enc IS NOT NULL) AS has_refresh_token
       FROM accounts WHERE owner_id = $1 ORDER BY platform`,
    [ownerId],
  );
}

export async function setConnectionMode(
  ownerId: string,
  platform: Platform,
  mode: 'disconnected' | 'simulated' | 'live',
): Promise<void> {
  await query(
    `UPDATE accounts SET connection_mode = $3, updated_at = now() WHERE owner_id = $1 AND platform = $2`,
    [ownerId, platform, mode],
  );
  await recordAudit({
    ownerId, actor: 'owner', action: 'account.set_mode', targetType: 'account', targetId: platform, detail: { mode },
  });
}

/** 送信直前に読む停止フラグ。 */
export async function getStopFlags(ownerId: string, platform: Platform): Promise<{ globalStop: boolean; platformStop: boolean }> {
  const row = await queryOne<SettingsRow>(
    `SELECT global_stop, threads_stop, x_stop FROM settings WHERE owner_id = $1`, [ownerId],
  );
  if (!row) return { globalStop: true, platformStop: true };
  return {
    globalStop: row.global_stop,
    platformStop: platform === 'x' ? row.x_stop : row.threads_stop,
  };
}
