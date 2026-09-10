'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Item = { id: string; kind: string; state: string; title: string; source: string };

export default function KnowledgeList({ items }: { items: Item[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setState(id: string, state: string) {
    setBusy(true);
    await fetch(`/api/knowledge/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    setBusy(false);
    router.refresh();
  }

  if (items.length === 0) {
    return (
      <div className="empty">
        <strong>知識が登録されていません</strong>
        <div className="small">
          content/operator-facts.json に本人が提供した知識を置き、seed スクリプトで投入します。
          本人が使ったAI名の組合せ・時間削減・受注数・売上改善・顧客名は補完しません。
        </div>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr><th>種別</th><th>タイトル</th><th>出典</th><th>状態</th><th /></tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <span className="badge">
                  {item.kind === 'operator_experience' ? '本人の経験' : '一般'}
                </span>
              </td>
              <td>{item.title}</td>
              <td className="small muted">{item.source}</td>
              <td><span className="badge">{item.state}</span></td>
              <td>
                {item.state === 'APPROVED' ? (
                  <button className="small secondary" disabled={busy}
                    onClick={() => setState(item.id, 'DRAFT')}>承認を外す</button>
                ) : (
                  <button className="small" disabled={busy}
                    onClick={() => setState(item.id, 'APPROVED')}>承認する</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
