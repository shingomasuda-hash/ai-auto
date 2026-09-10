'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type SettingsView = {
  globalStop: boolean;
  threadsStop: boolean;
  xStop: boolean;
  emailStop: boolean;
  aiGenerationEnabled: boolean;
  autoApproveEnabled: boolean;
  aiModel: string;
  monthlyBudgetYen: number;
  monthlyGoalYen: number;
  emailTestMode: boolean;
  allowedTestRecipients: string[];
};

export default function SettingsForm({ settings }: { settings: SettingsView }) {
  const router = useRouter();
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (key: keyof SettingsView) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.checked }));

  async function save() {
    setBusy(true);
    setMessage(null);
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    setBusy(false);
    setMessage(response.ok ? '保存しました。' : '保存できませんでした。');
    router.refresh();
  }

  return (
    <>
      <div className="card">
        <h2>処理の停止<span className="sub">送信の直前にも必ず確認されます</span></h2>
        {message && <div className="notice">{message}</div>}
        <div className="notice">
          停止すると、以降の送信は行われません。ただし、停止前にすでに外部へ送信された処理は取り消せません。
          その場合は結果が記録され、結果不明のものは再送せず隔離されます。
        </div>
        <Check label="全体を停止する" checked={form.globalStop} onChange={toggle('globalStop')} />
        <Check label="Threadsへの送信を停止する" checked={form.threadsStop} onChange={toggle('threadsStop')} />
        <Check label="Xへの送信を停止する" checked={form.xStop} onChange={toggle('xStop')} />
        <Check label="メール配信を停止する" checked={form.emailStop} onChange={toggle('emailStop')} />
        <p className="small muted">配信停止中でも、購読者からの解除は常に受け付けます。</p>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>AI</h2>
          <Check label="AIによる下書き生成を有効にする" checked={form.aiGenerationEnabled}
            onChange={toggle('aiGenerationEnabled')} />
          <Check label="生成した下書きを自動承認する" checked={form.autoApproveEnabled}
            onChange={toggle('autoApproveEnabled')} />
          <p className="small muted">初期はどちらも無効です。生成物は必ず下書きとして入ります。</p>
          <div className="field">
            <label htmlFor="aiModel">利用するモデル</label>
            <input id="aiModel" type="text" value={form.aiModel}
              onChange={(e) => setForm((prev) => ({ ...prev, aiModel: e.target.value }))}
              placeholder="利用可能なモデル名を設定します" />
          </div>
        </div>

        <div className="card">
          <h2>予算と目標</h2>
          <div className="field">
            <label htmlFor="budget">月次の運営費上限（円）</label>
            <input id="budget" type="number" step="1" min="0" value={form.monthlyBudgetYen}
              onChange={(e) => setForm((prev) => ({ ...prev, monthlyBudgetYen: Number(e.target.value) }))} />
          </div>
          <div className="field">
            <label htmlFor="goal">月次の利益目標（円）</label>
            <input id="goal" type="number" step="1" min="0" value={form.monthlyGoalYen}
              onChange={(e) => setForm((prev) => ({ ...prev, monthlyGoalYen: Number(e.target.value) }))} />
          </div>
          <p className="small muted">
            費用の反映には各社側の遅延があります。上限を超えないことを保証する表示は行いません。
          </p>
        </div>
      </div>

      <div className="card">
        <h2>メールのテスト送信</h2>
        <Check label="テストモード（指定した宛先以外へ送らない）" checked={form.emailTestMode}
          onChange={toggle('emailTestMode')} />
        <div className="field">
          <label htmlFor="recipients">テスト送信を許可する宛先（カンマ区切り）</label>
          <input id="recipients" type="text" value={form.allowedTestRecipients.join(', ')}
            onChange={(e) => setForm((prev) => ({
              ...prev,
              allowedTestRecipients: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
            }))} />
        </div>
        <p className="small muted">外部の人へのテスト送信は行いません。</p>
      </div>

      <div className="row end" style={{ marginBottom: 20 }}>
        <button onClick={save} disabled={busy}>{busy ? '保存中…' : '設定を保存'}</button>
      </div>
    </>
  );
}

function Check({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <label className="row" style={{ marginBottom: 8, fontWeight: 400, fontSize: 13.5, color: 'var(--ink)' }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
