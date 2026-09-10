import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/session.ts';
import LoginForm from './LoginForm.tsx';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  return (
    <div className="login-shell">
      <div className="login-card">
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>AnyWare AI発信・販売管理</h1>
          <p className="small muted" style={{ margin: 0 }}>所有者のみが利用できます。</p>
        </div>
        <div className="card">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
