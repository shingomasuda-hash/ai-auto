import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/session.ts';
import Nav from './Nav.tsx';

/**
 * ダッシュボードの全画面をここで認証保護する。
 * 未ログインならレンダリング前にログインへ送る。
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="shell">
      <Nav displayName={user.display_name || user.email} />
      <main className="main">{children}</main>
    </div>
  );
}
