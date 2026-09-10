'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { checkLength } from '../../../domain/text-length.ts';
import type { Platform } from '../../../domain/text-length.ts';

type KnowledgeOption = { id: string; title: string; kind: string };

const CATEGORIES = [
  { value: 'intent_organizing', label: '意図整理' },
  { value: 'design_specification', label: 'デザイン具体化' },
  { value: 'quality_judgement', label: '品質判断' },
  { value: 'general_tips', label: '一般ノウハウ' },
  { value: 'announcement', label: 'お知らせ' },
];

const CTA_KINDS = [
  { value: 'none', label: 'なし' },
  { value: 'free_material', label: '無料資料' },
  { value: 'sales_page', label: '販売ページ' },
  { value: 'note_product', label: 'note商品' },
];

export default function PostForm({ knowledge }: { knowledge: KnowledgeOption[] }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('intent_organizing');
  const [ctaKind, setCtaKind] = useState('none');
  const [ctaUrl, setCtaUrl] = useState('');
  const [threadsBody, setThreadsBody] = useState('');
  const [xBody, setXBody] = useState('');
  const [knowledgeIds, setKnowledgeIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const variants: { platform: Platform; body: string }[] = [];
  if (threadsBody.trim()) variants.push({ platform: 'threads', body: threadsBody });
  if (xBody.trim()) variants.push({ platform: 'x', body: xBody });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors([]);
    const response = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        category,
        ctaKind,
        ctaUrl: ctaKind === 'none' ? null : ctaUrl,
        variants: variants.map((v) => ({ ...v, knowledgeIds })),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      router.push('/posts');
      router.refresh();
      return;
    }
    setErrors(body.errors ?? [body.error ?? '保存できませんでした。']);
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit}>
      {errors.length > 0 && (
        <div className="errors">
          <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
        </div>
      )}

      <div className="field">
        <label htmlFor="title">内部用のタイトル</label>
        <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="管理用の名前。投稿本文には含まれません。" />
      </div>

      <div className="grid cols-2">
        <div className="field">
          <label htmlFor="category">カテゴリ</label>
          <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cta">CTA</label>
          <select id="cta" value={ctaKind} onChange={(e) => setCtaKind(e.target.value)}>
            {CTA_KINDS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {ctaKind !== 'none' && (
        <div className="field">
          <label htmlFor="ctaUrl">CTAのURL</label>
          <input id="ctaUrl" type="url" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)}
            placeholder="https://" required />
        </div>
      )}

      <BodyField platform="threads" label="Threads向けの本文" value={threadsBody} onChange={setThreadsBody} />
      <BodyField platform="x" label="X向けの本文（別の下書きとして作成されます）" value={xBody} onChange={setXBody} />

      <div className="field">
        <label>参照する知識</label>
        {knowledge.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            承認済みの知識がありません。設定画面から登録・承認してください。
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {knowledge.map((item) => (
              <label key={item.id} className="row small" style={{ marginBottom: 0, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={knowledgeIds.includes(item.id)}
                  onChange={(e) => setKnowledgeIds((prev) =>
                    e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id),
                  )}
                />
                <span>
                  {item.title}
                  <span className="badge" style={{ marginLeft: 6 }}>
                    {item.kind === 'operator_experience' ? '本人の経験' : '一般'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="row end">
        <button type="submit" disabled={busy || variants.length === 0}>
          {busy ? '保存中…' : '下書きとして保存'}
        </button>
      </div>
      {variants.length === 0 && (
        <p className="small muted row end" style={{ marginBottom: 0 }}>
          少なくとも一方の本文を入力してください。
        </p>
      )}
    </form>
  );
}

function BodyField({
  platform, label, value, onChange,
}: { platform: Platform; label: string; value: string; onChange: (v: string) => void }) {
  const check = checkLength(platform, value);
  return (
    <div className="field">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label htmlFor={`body-${platform}`}>{label}</label>
        <span className={`counter${check.length > check.max ? ' over' : ''}`}>
          {check.length} / {check.max}
        </span>
      </div>
      <textarea id={`body-${platform}`} value={value} onChange={(e) => onChange(e.target.value)} />
      {platform === 'x' && (
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          Xは全角を2文字、URLを23文字として数えます（公式の重み付き計算）。
        </p>
      )}
    </div>
  );
}
