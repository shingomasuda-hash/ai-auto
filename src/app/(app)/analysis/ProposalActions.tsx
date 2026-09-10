'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ProposalActions({ id }: { id: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function decide(state: 'ACCEPTED' | 'REJECTED') {
    setBusy(true);
    await fetch(`/api/proposals/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, note }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div style={{ marginTop: 10 }}>
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="判断の理由（任意）" style={{ marginBottom: 8 }} />
      <div className="actions">
        <button className="small" disabled={busy} onClick={() => decide('ACCEPTED')}>採用する</button>
        <button className="small secondary" disabled={busy} onClick={() => decide('REJECTED')}>却下する</button>
      </div>
    </div>
  );
}
