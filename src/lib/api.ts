import { NextResponse } from 'next/server';
import { requireOwner, UnauthorizedError } from './session.ts';
import type { User } from '../db/auth.ts';

export type ApiHandler<T> = (user: User, request: Request, context: T) => Promise<NextResponse>;

/**
 * APIの共通ラッパ。
 * 未ログインなら本文を返さず 401。所有者のIDはここでしか渡さない。
 */
export function withOwner<T>(handler: ApiHandler<T>) {
  return async (request: Request, context: T): Promise<NextResponse> => {
    let user: User;
    try {
      user = await requireOwner();
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json({ error: '認証が必要です。' }, { status: 401 });
      }
      throw error;
    }
    try {
      return await handler(user, request, context);
    } catch (error) {
      console.error('[api]', error);
      return NextResponse.json({ error: '処理中にエラーが発生しました。' }, { status: 500 });
    }
  };
}

export function badRequest(errors: string[]): NextResponse {
  return NextResponse.json({ errors }, { status: 400 });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function optionalStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}
