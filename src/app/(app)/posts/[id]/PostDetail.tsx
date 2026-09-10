'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { checkLength } from '../../../../domain/text-length.ts';
import type { Platform } from '../../../../domain/text-length.ts';
import type { PostState } from '../../../../domain/post-state.ts';
import { isEditable } from '../../../../domain/post-state.ts';

type VariantView = {
  id: string;
  platform: Platform;
  body: string;
  state: PostState;
  scheduledAt: string | null;
};

/** UTCのISO文字列を datetime-local(JST) の値へ。 */
function toJstInput(iso: string | null): string {
  if (!iso) return '';
  const shifted = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return shifted.toISOString().slice(0, 16);
}

export default function PostDetail({
  variant, ownerActions,
}: { variant: VariantView; ownerActions: PostState[] }) {
  const router = useRouter();
  const [body, setBody] = useState(variant.body);
  const [scheduledAt, setScheduledAt] = useState(toJstInput(variant.scheduledAt));
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editable = isEditable(variant.state);
  const check = checkLength(variant.platform, body);
  const bodyChanged = body !== variant.body;

  async function call(path: string, payload: Record<string, unknown>) {
    setBusy(true);
    setErrors([]);
    setMessage(null);
    const response = await fetch(`/api/posts/${variant.id}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setErrors(result.errors ?? [result.error ?? '処理できませんでした。']);
      return false;
    }
    if (result.message) setMessage(result.message);
    router.refresh();
    return true;
  }

  return (
    <>
      {errors.length > 0 && (
        <div className="errors"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      )}
      {message && <div className="notice">{message}</div>}

      <div className="field">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label htmlFor="body">本文</label>
          <span className={`counter${check.length > check.max ? ' over' : ''}`}>
            {check.length} / {check.max}
          </span>
        </div>
        <textarea id="body" value={body} disabled={!editable}
          onChange={(e) => setBody(e.target.value)} />
        {!editable && (
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {variant.state} の投稿は編集できません。
          </p>
        )}
        {editable && bodyChanged && (variant.state === 'APPROVED' || variant.state === 'SCHEDULED') && (
          <p className="small pill-warn" style={{ margin: '4px 0 0' }}>
            保存すると承認が取り消され、再承認が必要になります。予約も解除されます。
          </p>
        )}
      </div>

      <div className="actions" style={{ marginBottom: 18 }}>
        {editable && (
          <button className="secondary" disabled={busy || !bodyChanged || !check.ok}
            onClick={() => call('body', { body })}>
            本文を保存
          </button>
        )}
        {ownerActions.includes('APPROVED') && variant.state === 'DRAFT' && (
          <button disabled={busy || bodyChanged} onClick={() => call('approve', {})}>承認する</button>
        )}
        {ownerActions.includes('DRAFT') && variant.state !== 'DRAFT' && (
          <button className="secondary" disabled={busy} onClick={() => call('revert', {})}>
            下書きへ戻す
          </button>
        )}
        {variant.state === 'SCHEDULED' && (
          <button className="danger" disabled={busy} onClick={() => call('cancel-schedule', {})}>
            予約を取り消す
          </button>
        )}
      </div>

      {(variant.state === 'APPROVED' || variant.state === 'SCHEDULED') && (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <div className="field">
            <label htmlFor="scheduledAt">予約日時（JST）</label>
            <input id="scheduledAt" type="datetime-local" value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)} />
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              保存はUTCで行われます。運営上限は各媒体1日3件・同一媒体は2時間以上あける、です。
            </p>
          </div>
          <div className="actions">
            <button disabled={busy || !scheduledAt}
              onClick={() => call('schedule', { scheduledAt })}>
              {variant.state === 'SCHEDULED' ? '予約を変更' : '予約する'}
            </button>
            <button className="secondary" disabled={busy || !scheduledAt}
              onClick={() => call('schedule', { scheduledAt, allowDuplicate: true })}>
              重複を許可して予約
            </button>
          </div>
        </div>
      )}
    </>
  );
}
