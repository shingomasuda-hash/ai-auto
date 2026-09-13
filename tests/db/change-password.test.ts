import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, createTestOwner, query, dbAvailable } from './helpers.ts';
import { changePassword } from '../../scripts/change-password.ts';
import { authenticate, createSession, findUserBySessionToken } from '../../src/db/auth.ts';

const options = { skip: dbAvailable ? false : 'TEST_DATABASE_URL が未設定のためスキップ' };

const OLD = 'test-password-123456';
const NEW = 'brand-new-password-987';

let ownerId = '';
let ownerEmail = '';

before(async () => { if (dbAvailable) await setupDb(); });
after(async () => { if (dbAvailable) await teardownDb(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await setupDb();
  const owner = await createTestOwner();
  ownerId = owner.id;
  ownerEmail = owner.email;
});

test('変更後は新しいパスワードだけが通る', options, async () => {
  assert.notEqual(await authenticate(ownerEmail, OLD), null, '前提: 変更前は通る');

  await changePassword(ownerEmail, NEW);

  assert.equal(await authenticate(ownerEmail, OLD), null, '古いパスワードがまだ通る');
  assert.notEqual(await authenticate(ownerEmail, NEW), null, '新しいパスワードが通らない');
});

test('変更でログイン中のセッションが無効になる', options, async () => {
  const { token } = await createSession(ownerId, 'test');
  assert.notEqual(await findUserBySessionToken(token), null, '前提: セッションは有効');

  const result = await changePassword(ownerEmail, NEW);
  assert.equal(result.sessionsRevoked, 1);
  assert.equal(await findUserBySessionToken(token), null, '古いセッションが残っている');
});

test('他人のセッションは巻き込まない', options, async () => {
  const other = await createTestOwner();
  const otherSession = await createSession(other.id, 'test');

  await changePassword(ownerEmail, NEW);

  assert.notEqual(await findUserBySessionToken(otherSession.token), null, '他人のセッションが消えている');
  assert.notEqual(await authenticate(other.email, OLD), null, '他人のパスワードが変わっている');
});

test('短いパスワードは拒否する', options, async () => {
  await assert.rejects(() => changePassword(ownerEmail, 'short'), /12文字以上/);
  assert.notEqual(await authenticate(ownerEmail, OLD), null, '拒否されたのに変更されている');
});

test('存在しない所有者は変更できない', options, async () => {
  await assert.rejects(() => changePassword('nobody@example.test', NEW), /見つかりません/);
});

test('変更が監査ログに残る', options, async () => {
  await changePassword(ownerEmail, NEW);
  const rows = await query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE owner_id = $1 AND action = 'auth.password_changed'`,
    [ownerId],
  );
  assert.equal(rows.length, 1);
});

test('ハッシュは毎回変わる（同じパスワードでも）', options, async () => {
  await changePassword(ownerEmail, NEW);
  const first = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [ownerId]);
  await changePassword(ownerEmail, NEW);
  const second = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [ownerId]);
  assert.notEqual(first[0].password_hash, second[0].password_hash, 'ソルトが固定されている');
  assert.notEqual(await authenticate(ownerEmail, NEW), null);
});
