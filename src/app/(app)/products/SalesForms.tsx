'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Channel = 'note' | 'coconala' | 'other';

type ProductOption = { code: string; name: string; priceYen: number; channel: Channel };

const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'note', label: 'note' },
  { value: 'coconala', label: 'ココナラ' },
  { value: 'other', label: 'その他' },
];

export default function SalesForms({ products }: { products: ProductOption[] }) {
  return (
    <div className="grid cols-2">
      <ManualForm products={products} />
      <CsvForm />
    </div>
  );
}

function ManualForm({ products }: { products: ProductOption[] }) {
  const router = useRouter();
  const [form, setForm] = useState({
    externalOrderId: '',
    channel: 'note' as Channel,
    kind: 'SALE',
    productCode: products.find((p) => p.channel === 'note')?.code ?? '',
    grossYen: String(products.find((p) => p.channel === 'note')?.priceYen ?? ''),
    feeYen: '',
    occurredAt: '',
    settledOn: '',
    note: '',
  });

  // 選んだチャネルの商品だけを候補にする。
  const channelProducts = products.filter((p) => p.channel === form.channel);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  // チャネルを変えたら、その配下の商品へ選び直す。
  const setChannel = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const channel = event.target.value as Channel;
    const first = products.find((p) => p.channel === channel);
    setForm((prev) => ({
      ...prev,
      channel,
      productCode: first?.code ?? '',
      grossYen: first ? String(first.priceYen) : prev.grossYen,
    }));
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors([]);
    setMessage(null);
    const response = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setErrors(body.errors ?? [body.error ?? '登録できませんでした。']);
      return;
    }
    setMessage(body.message ?? '登録しました。');
    setForm((prev) => ({ ...prev, externalOrderId: '', feeYen: '', note: '' }));
    router.refresh();
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>売上を手動で入力</h2>
      {errors.length > 0 && <div className="errors"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      {message && <div className="notice">{message}</div>}

      <div className="field">
        <label htmlFor="orderId">注文ID（重複防止に使います）</label>
        <input id="orderId" type="text" value={form.externalOrderId} onChange={set('externalOrderId')} required />
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label htmlFor="channel">販売チャネル</label>
          <select id="channel" value={form.channel} onChange={setChannel}>
            {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="kind">区分</label>
          <select id="kind" value={form.kind} onChange={set('kind')}>
            <option value="SALE">売上</option>
            <option value="REFUND">返金</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="productCode">商品</label>
        {channelProducts.length === 0 ? (
          <input id="productCode" type="text" value={form.productCode} onChange={set('productCode')}
            placeholder="商品コード（このチャネルの商品が未登録です）" required />
        ) : (
          <select id="productCode" value={form.productCode} onChange={set('productCode')}>
            {channelProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        )}
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label htmlFor="grossYen">金額（円・整数）</label>
          <input id="grossYen" type="number" step="1" min="0" value={form.grossYen} onChange={set('grossYen')} required />
        </div>
        <div className="field">
          <label htmlFor="feeYen">販売手数料（不明なら空欄）</label>
          <input id="feeYen" type="number" step="1" min="0" value={form.feeYen} onChange={set('feeYen')} />
        </div>
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label htmlFor="occurredAt">購入日時（JST）</label>
          <input id="occurredAt" type="datetime-local" value={form.occurredAt} onChange={set('occurredAt')} required />
        </div>
        <div className="field">
          <label htmlFor="settledOn">入金日（未入金なら空欄）</label>
          <input id="settledOn" type="date" value={form.settledOn} onChange={set('settledOn')} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="note">備考</label>
        <input id="note" type="text" value={form.note} onChange={set('note')} />
      </div>
      <div className="row end">
        <button type="submit" disabled={busy}>{busy ? '登録中…' : '登録する'}</button>
      </div>
    </form>
  );
}

function CsvForm() {
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [channel, setChannel] = useState<Channel>('note');
  const [result, setResult] = useState<null | {
    insertedCount: number;
    duplicatesInFile: { line: number; externalOrderId: string }[];
    duplicatesInDb: { line: number; externalOrderId: string }[];
    invalid: { line: number; errors: string[] }[];
  }>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const response = await fetch('/api/sales/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv, channel }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    setResult(body);
    router.refresh();
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>CSVから取り込む</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        1行目をヘッダにしてください。列名は日本語の別名も受け付けます
        （注文ID / 取引ID、金額 / 販売金額、手数料、購入日時 / 取引日、入金日 など）。
        <strong>同じ注文IDは何度取り込んでも1件だけ登録されます。</strong>
        ココナラの「売上データ全件ダウンロード」のように毎回全期間が出力される
        形式でも、そのまま貼って構いません。
      </p>
      <div className="field">
        <label htmlFor="csvChannel">このCSVの販売チャネル</label>
        <select id="csvChannel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
          {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="csv">CSVの内容</label>
        <textarea id="csv" value={csv} onChange={(e) => setCsv(e.target.value)}
          placeholder={'order_id,kind,product_code,gross_yen,fee_yen,occurred_at\nORD-1,SALE,starter,1980,297,2026-04-01'} />
      </div>
      <div className="row end">
        <button type="submit" disabled={busy || csv.trim() === ''}>{busy ? '取込中…' : '取り込む'}</button>
      </div>

      {result && (
        <div className="notice" style={{ marginTop: 14, marginBottom: 0 }}>
          <div>登録: {result.insertedCount} 件</div>
          {result.duplicatesInFile.length > 0 && (
            <div>ファイル内の重複: {result.duplicatesInFile.length} 件（{result.duplicatesInFile.map((d) => d.externalOrderId).join(', ')}）</div>
          )}
          {result.duplicatesInDb.length > 0 && (
            <div>登録済みのため除外: {result.duplicatesInDb.length} 件</div>
          )}
          {result.invalid.length > 0 && (
            <div>
              取り込めなかった行: {result.invalid.length} 件
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.invalid.map((row) => (
                  <li key={row.line}>{row.line}行目: {row.errors.join(' / ')}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
