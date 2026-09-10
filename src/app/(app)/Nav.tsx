'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const LINKS = [
  { href: '/dashboard', label: '概要' },
  { href: '/posts', label: '投稿' },
  { href: '/calendar', label: 'カレンダー' },
  { href: '/analysis', label: '分析/改善' },
  { href: '/products', label: '商品/売上' },
  { href: '/settings', label: '設定' },
];

export default function Nav({ displayName }: { displayName: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <nav className="sidebar">
      <div className="brand">
        AnyWare
        <small>AI発信・販売管理</small>
      </div>
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="nav-link"
          aria-current={pathname === link.href || pathname.startsWith(`${link.href}/`) ? 'page' : undefined}
        >
          {link.label}
        </Link>
      ))}
      <div className="spacer" />
      <div className="small muted" style={{ padding: '0 10px 6px' }}>{displayName}</div>
      <button className="secondary small" onClick={logout} style={{ margin: '0 6px' }}>ログアウト</button>
    </nav>
  );
}
