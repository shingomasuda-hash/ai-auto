/**
 * DBテストの共通処理。
 * TEST_DATABASE_URL が無い環境ではテストをスキップする。
 */
import { readFileSync, existsSync } from 'node:fs';
import { getPool, closePool, query } from '../../src/db/pool.ts';
import { migrate } from '../../scripts/migrate.ts';
import { createUser } from '../../src/db/auth.ts';

function loadEnvLocal(): void {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

loadEnvLocal();

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const dbAvailable = TEST_DATABASE_URL !== '';

if (dbAvailable) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
}

let migrated = false;

const TABLES = [
  'audit_logs', 'email_deliveries', 'consents', 'subscribers', 'click_events',
  'budget_reservations', 'budget_envelopes', 'expense_entries', 'sales',
  'improvement_proposals', 'metric_snapshots', 'jobs', 'publish_attempts',
  'post_knowledge_refs', 'post_variants', 'posts', 'products', 'knowledge',
  'accounts', 'settings', 'sessions', 'users',
];

export async function setupDb(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function teardownDb(): Promise<void> {
  await closePool();
}

let userCounter = 0;

export async function createTestOwner(): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const email = `owner${userCounter}-${Date.now()}@example.test`;
  const user = await createUser(email, 'test-password-123456', 'テスト所有者');
  return { id: user.id, email: user.email };
}

export { getPool, query };
