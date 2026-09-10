import { requireOwner } from '../../../lib/session.ts';
import { getSettings, listAccounts } from '../../../db/settings.ts';
import { listKnowledge } from '../../../db/knowledge.ts';
import { formatJst } from '../../../domain/time.ts';
import { formatYen } from '../../../domain/money.ts';
import { PageHeader } from '../_ui.tsx';
import SettingsForm from './SettingsForm.tsx';
import KnowledgeList from './KnowledgeList.tsx';

export const dynamic = 'force-dynamic';

const MODE_LABELS: Record<string, string> = {
  disconnected: '未接続',
  simulated: '模擬接続（外部へ送信しません）',
  live: '本番接続',
};

export default async function SettingsPage() {
  const user = await requireOwner();
  const [settings, accounts, knowledge] = await Promise.all([
    getSettings(user.id),
    listAccounts(user.id),
    listKnowledge(user.id),
  ]);

  return (
    <>
      <PageHeader title="設定" description="接続状態、AI、予算、処理の停止、管理者情報" />

      <div className="card">
        <h2>媒体の接続状態</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>媒体</th><th>状態</th><th>アカウント</th>
                <th>トークン</th><th>有効期限</th><th>直近のエラー</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.platform === 'x' ? 'X' : 'Threads'}</td>
                  <td>
                    <span className={`badge${account.connection_mode === 'live' ? ' state-PUBLISHED' : ''}`}>
                      {MODE_LABELS[account.connection_mode]}
                    </span>
                  </td>
                  <td className="small">{account.display_name || <span className="muted">—</span>}</td>
                  <td className="small">
                    {/* 鍵そのものは表示しない。保存されているかどうかだけを示す。 */}
                    {account.has_access_token ? '保存済み' : <span className="muted">未保存</span>}
                  </td>
                  <td className="small">{formatJst(account.token_expires_at)}</td>
                  <td className="small pill-bad">{account.last_error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
          APIキーやトークンの値はこの画面に表示しません。接続の追加は環境変数と管理コマンドで行います。
        </p>
      </div>

      <SettingsForm
        settings={{
          globalStop: settings.global_stop,
          threadsStop: settings.threads_stop,
          xStop: settings.x_stop,
          emailStop: settings.email_stop,
          aiGenerationEnabled: settings.ai_generation_enabled,
          autoApproveEnabled: settings.auto_approve_enabled,
          aiModel: settings.ai_model,
          monthlyBudgetYen: settings.monthly_budget_yen,
          monthlyGoalYen: settings.monthly_goal_yen,
          emailTestMode: settings.email_test_mode,
          allowedTestRecipients: settings.allowed_test_recipients,
        }}
      />

      <div className="card">
        <h2>知識<span className="sub">一般ノウハウと本人の経験は別種として保存する</span></h2>
        <KnowledgeList
          items={knowledge.map((k) => ({
            id: k.id, kind: k.kind, state: k.state, title: k.title, source: k.source,
          }))}
        />
      </div>

      <div className="card">
        <h2>管理者</h2>
        <table>
          <tbody>
            <tr><th>メールアドレス</th><td>{user.email}</td></tr>
            <tr><th>表示名</th><td>{user.display_name || '—'}</td></tr>
            <tr><th>権限</th><td>所有者（全画面）</td></tr>
            <tr><th>月次目標</th><td>{formatYen(settings.monthly_goal_yen)}</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
