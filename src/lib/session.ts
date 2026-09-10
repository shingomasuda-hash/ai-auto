import { cookies } from 'next/headers';
import { cache } from 'react';
import { SESSION_COOKIE, findUserBySessionToken } from '../db/auth.ts';
import type { User } from '../db/auth.ts';

/** 現在のログインユーザー。未ログインなら null。 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return findUserBySessionToken(token);
});

/**
 * 所有者であることを要求する。未ログインなら例外。
 * すべての画面・APIの入口で必ず呼ぶ。
 */
export async function requireOwner(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('認証が必要です。');
    this.name = 'UnauthorizedError';
  }
}
