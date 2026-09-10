import type { PostState } from '../../domain/post-state.ts';
import { formatYen } from '../../domain/money.ts';

export function StateBadge({ state }: { state: PostState }) {
  const labels: Record<PostState, string> = {
    DRAFT: '下書き',
    APPROVED: '承認済み',
    SCHEDULED: '予約済み',
    CLAIMED: '取得済み',
    PUBLISHING: '送信中',
    PUBLISHED: '公開済み',
    FAILED: '失敗',
    UNKNOWN: '結果不明',
    EXPIRED: '期限切れ',
  };
  return <span className={`badge state-${state}`}>{labels[state]}</span>;
}

export function PlatformLabel({ platform }: { platform: string }) {
  return <span className="badge">{platform === 'x' ? 'X' : 'Threads'}</span>;
}

/**
 * 数値の表示。確定できない値は数字を出さず理由を書く。
 * 架空の値で埋めない。
 */
export function Stat({
  label, value, note, unresolved,
}: { label: string; value: number | null; note?: string; unresolved?: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`value${value === null ? ' muted' : ''}`}>
        {value === null ? '未確定' : formatYen(value)}
      </span>
      {value === null && unresolved && <span className="note">{unresolved}</span>}
      {value !== null && note && <span className="note">{note}</span>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}
