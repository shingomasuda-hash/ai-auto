import Link from 'next/link';
import { requireOwner } from '../../../lib/session.ts';
import { listScheduledInRange } from '../../../db/posts.ts';
import { jstMonthKey, jstMonthRange, toJstParts, fromJstParts, jstDateKey } from '../../../domain/time.ts';
import { PageHeader, Empty } from '../_ui.tsx';

export const dynamic = 'force-dynamic';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const now = new Date();
  const monthKey = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : jstMonthKey(now);

  const { startUtc, endUtcExclusive } = jstMonthRange(monthKey);
  const variants = await listScheduledInRange(user.id, startUtc, endUtcExclusive);

  // JSTの暦日ごとにまとめる。
  const byDate = new Map<string, typeof variants>();
  for (const variant of variants) {
    const at = variant.published_at ?? variant.scheduled_at;
    if (!at) continue;
    const key = jstDateKey(at);
    const list = byDate.get(key) ?? [];
    list.push(variant);
    byDate.set(key, list);
  }

  const [year, month] = monthKey.split('-').map(Number);
  const firstDay = fromJstParts({ year, month, day: 1, hour: 12, minute: 0 });
  const firstDow = toJstParts(firstDay).day === 1
    ? new Date(firstDay.getTime() + 9 * 3600_000).getUTCDay()
    : 0;
  const daysInMonth = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 0)).getUTCDate();
  const todayKey = jstDateKey(now);

  const cells: { key: string | null; day: number | null }[] = [];
  for (let i = 0; i < firstDow; i += 1) cells.push({ key: null, day: null });
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ key: `${monthKey}-${String(day).padStart(2, '0')}`, day });
  }

  const prev = shiftMonth(monthKey, -1);
  const next = shiftMonth(monthKey, 1);

  return (
    <>
      <PageHeader title="カレンダー" description="予約と公開の状況（JSTで表示・UTCで保存）" />

      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="row">
          <Link href={`/calendar?month=${prev}`} className="btn secondary small">← {prev}</Link>
          <strong style={{ fontSize: 15 }}>{monthKey}</strong>
          <Link href={`/calendar?month=${next}`} className="btn secondary small">{next} →</Link>
        </div>
        <span className="small muted">{variants.length} 件</span>
      </div>

      {variants.length === 0 ? (
        <div className="card">
          <Empty title={`${monthKey} に予約・公開された投稿はありません`}>
            <div className="small">投稿画面で承認してから予約すると、ここに表示されます。</div>
          </Empty>
        </div>
      ) : (
        <div className="card">
          <div className="cal">
            {DOW.map((label) => <div className="dow" key={label}>{label}</div>)}
            {cells.map((cell, index) => (
              <div
                key={cell.key ?? `pad-${index}`}
                className={`day${cell.key === null ? ' other' : ''}${cell.key === todayKey ? ' today' : ''}`}
              >
                <div className="n">{cell.day ?? ''}</div>
                {(cell.key ? byDate.get(cell.key) ?? [] : []).map((variant) => {
                  const at = variant.published_at ?? variant.scheduled_at!;
                  const parts = toJstParts(at);
                  return (
                    <Link key={variant.id} href={`/posts/${variant.id}`}
                      className={`item ${variant.platform}`}
                      title={`${variant.state} / ${variant.body.slice(0, 60)}`}>
                      {String(parts.hour).padStart(2, '0')}:{String(parts.minute).padStart(2, '0')}{' '}
                      {variant.platform === 'x' ? 'X' : 'Th'}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
            期限切れ（予約から24時間超過）の投稿は自動で EXPIRED になり、まとめて投稿し直すことはありません。
          </p>
        </div>
      )}
    </>
  );
}

function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
