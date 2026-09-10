'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.ok) {
      router.replace('/dashboard');
      router.refresh();
      return;
    }
    const body = await response.json().catch(() => ({ error: 'ログインできませんでした。' }));
    setError(body.error ?? 'ログインできませんでした。');
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit}>
      {error && <div className="errors">{error}</div>}
      <div className="field">
        <label htmlFor="email">メールアドレス</label>
        <input id="email" type="email" autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="password">パスワード</label>
        <input id="password" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <button type="submit" disabled={busy} style={{ width: '100%' }}>
        {busy ? 'ログイン中…' : 'ログイン'}
      </button>
    </form>
  );
}
