/**
 * 認証の実地検証。
 *
 * 画面もAPIも、未ログインではデータを取得できないことをHTTPで確かめる。
 * ビルド済みのアプリを起動して実際にリクエストする。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { setupDb, teardownDb, createTestOwner, dbAvailable, TEST_DATABASE_URL } from './helpers.ts';
import { createPost } from '../../src/db/posts.ts';

// 実際のHTTP経路で確かめるため、ビルド済みのアプリが必要。
const built = existsSync('.next/BUILD_ID');
const options = {
  skip: !dbAvailable
    ? 'TEST_DATABASE_URL が未設定のためスキップ'
    : !built
      ? 'ビルドがないためスキップ。`npm run build` の後に再実行してください。'
      : false,
};

const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'test-password-123456';

let server: ChildProcess | null = null;
let ownerEmail = '';
let ownerId = '';
let variantId = '';

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // まだ起動していない
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('サーバーが起動しませんでした。');
}

before(async () => {
  if (!dbAvailable || !built) return;
  await setupDb();
  const owner = await createTestOwner();
  ownerEmail = owner.email;
  ownerId = owner.id;

  const post = await createPost({
    ownerId,
    title: '認証テスト用',
    category: 'general_tips',
    ctaKind: 'none',
    ctaUrl: null,
    variants: [{ platform: 'threads', body: '認証テスト用の本文です。秘密の内容。' }],
  });
  variantId = post.ok ? post.variants[0].id : '';

  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: 'production',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  server?.kill('SIGTERM');
  if (dbAvailable && built) await teardownDb();
});

const PROTECTED_PAGES = ['/dashboard', '/posts', '/calendar', '/analysis', '/products', '/settings'];

test('未ログインでは全画面がログインへ転送される', options, async () => {
  for (const path of PROTECTED_PAGES) {
    const response = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    assert.ok(
      response.status === 307 || response.status === 302,
      `${path} が転送されない (status=${response.status})`,
    );
    assert.match(response.headers.get('location') ?? '', /\/login/, `${path} の転送先`);
  }
});

test('未ログインではAPIがデータを返さず401になる', options, async () => {
  const gets = ['/api/posts', '/api/settings'];
  for (const path of gets) {
    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 401, `${path} が401でない`);
    const text = await response.text();
    assert.doesNotMatch(text, /秘密の内容/, `${path} が本文を漏らしている`);
  }
});

test('未ログインではAPIの更新操作も401になる', options, async () => {
  const posts: [string, unknown][] = [
    ['/api/posts', { category: 'general_tips', variants: [{ platform: 'x', body: 'x' }] }],
    [`/api/posts/${variantId}/approve`, {}],
    [`/api/posts/${variantId}/schedule`, { scheduledAt: '2030-01-01T10:00' }],
    [`/api/posts/${variantId}/body`, { body: '書き換え' }],
    ['/api/sales', { externalOrderId: 'x', productCode: 'p', grossYen: 1, occurredAt: '2030-01-01T10:00' }],
    ['/api/sales/import', { csv: 'order_id\nA1' }],
    ['/api/settings', { globalStop: false }],
  ];
  for (const [path, payload] of posts) {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 401, `${path} が401でない`);
  }
});

test('未ログインの更新操作はDBを変更していない', options, async () => {
  const { getVariant } = await import('../../src/db/posts.ts');
  const variant = await getVariant(ownerId, variantId);
  assert.equal(variant?.state, 'DRAFT');
  assert.equal(variant?.body, '認証テスト用の本文です。秘密の内容。');
});

test('でたらめなセッションCookieでは通らない', options, async () => {
  const response = await fetch(`${BASE}/api/posts`, {
    headers: { cookie: 'aiops_session=deadbeefdeadbeefdeadbeef' },
  });
  assert.equal(response.status, 401);
});

test('誤ったパスワードではログインできない', options, async () => {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: 'wrong-password-000' }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.getSetCookie().some((c) => c.startsWith('aiops_session=')), false);
});

test('存在しないユーザーでもエラー文を変えない', options, async () => {
  const unknown = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'whatever-123456' }),
  });
  const wrongPassword = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: 'wrong-password-000' }),
  });
  assert.equal(unknown.status, wrongPassword.status);
  assert.deepEqual(await unknown.json(), await wrongPassword.json());
});

test('ログインすればデータを取得でき、ログアウトで取得できなくなる', options, async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('aiops_session='));
  assert.ok(setCookie, 'セッションCookieが発行される');
  assert.match(setCookie!, /HttpOnly/i, 'HttpOnly が付いている');
  assert.match(setCookie!, /SameSite=lax/i, 'SameSite が付いている');
  const cookie = setCookie!.split(';')[0];

  const authed = await fetch(`${BASE}/api/posts`, { headers: { cookie } });
  assert.equal(authed.status, 200);
  const body = await authed.json();
  assert.equal(body.variants.length, 1);
  assert.match(body.variants[0].body, /秘密の内容/);

  // 画面も表示できる
  const page = await fetch(`${BASE}/dashboard`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(page.status, 200);

  await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  const afterLogout = await fetch(`${BASE}/api/posts`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401, 'ログアウト後は同じCookieで取得できない');
});

test('他人のデータは所有者スコープで見えない', options, async () => {
  const intruder = await createTestOwner();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: intruder.email, password: PASSWORD }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('aiops_session='))!.split(';')[0];

  const list = await fetch(`${BASE}/api/posts`, { headers: { cookie } });
  const body = await list.json();
  assert.deepEqual(body.variants, [], '他人の投稿が一覧に出てはいけない');

  // IDを直接指定しても操作できない
  const approve = await fetch(`${BASE}/api/posts/${variantId}/approve`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(approve.status, 400);

  const detail = await fetch(`${BASE}/posts/${variantId}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(detail.status, 404, '他人の投稿の詳細画面は404');

  const { getVariant } = await import('../../src/db/posts.ts');
  assert.equal((await getVariant(ownerId, variantId))?.state, 'DRAFT', '元の投稿は変わっていない');
});

test('所有者がいるうちは、健全性の詳細を未ログインへ返さない', options, async () => {
  const response = await fetch(`${BASE}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  // 所有者が存在するので、詳細は隠して { ok: true } だけ返す
  assert.deepEqual(body, { ok: true });
  assert.equal('env' in body, false);
  assert.equal('databaseReachable' in body, false);
});

test('ログイン後は健全性の詳細が見え、値は含まれない', options, async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: PASSWORD }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('aiops_session='))!.split(';')[0];

  const response = await fetch(`${BASE}/api/health`, { headers: { cookie } });
  const body = await response.json();
  assert.equal(body.databaseReachable, true);
  assert.ok(body.migrationsApplied > 0);
  assert.equal(body.ownerExists, true);
  assert.equal(body.setupComplete, true);

  // env は「設定の有無」だけで、値は入っていない
  assert.equal(typeof body.env.DATABASE_URL, 'boolean');
  assert.equal(body.env.DATABASE_URL, true);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /postgres:\/\//, '接続文字列が漏れている');
  assert.doesNotMatch(serialized, /aiauto/, 'DB名やユーザー名が漏れている');
});

test('所有者がいる状態では、未知のユーザーでも設定の問題として扱わない', options, async () => {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.test', password: 'whatever-123456' }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.setupIssue, undefined, '所有者がいるのに設定の問題として返している');
});
