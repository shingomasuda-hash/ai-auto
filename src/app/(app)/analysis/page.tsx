import { requireOwner } from '../../../lib/session.ts';
import { listSnapshots, listProposals, clicksByVariant } from '../../../db/metrics.ts';
import { listVariants } from '../../../db/posts.ts';
import { listSales } from '../../../db/sales.ts';
import { compareGroups, attributeSales, ELAPSED_BUCKETS_HOURS } from '../../../domain/metrics.ts';
import type { ElapsedBucketHours, MetricKey } from '../../../domain/metrics.ts';
import { formatJst } from '../../../domain/time.ts';
import { PageHeader, Empty } from '../_ui.tsx';
import ProposalActions from './ProposalActions.tsx';

export const dynamic = 'force-dynamic';

const METRIC_LABELS: Record<MetricKey, string> = {
  impressions: '表示数',
  likes: 'いいね',
  replies: '返信',
  reposts: '再投稿',
  linkClicks: 'クリック',
};

export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const bucket = (ELAPSED_BUCKETS_HOURS as readonly number[]).includes(Number(params.bucket))
    ? (Number(params.bucket) as ElapsedBucketHours)
    : 24;

  const [snapshots, proposals, published, clicks, sales] = await Promise.all([
    listSnapshots(user.id),
    listProposals(user.id),
    listVariants(user.id, { states: ['PUBLISHED'] }),
    clicksByVariant(user.id),
    listSales(user.id, 1),
  ]);

  // カテゴリで群分けして、同じ経過時間どうしで比較する。
  const labeled = published.map((v) => ({ postId: v.id, label: v.category }));
  const comparisons = (['linkClicks', 'likes', 'impressions'] as MetricKey[])
    .map((metric) => compareGroups(snapshots, labeled, metric, bucket));

  const attribution = attributeSales({
    perPurchaseLinkAvailable: false,
    clicksByPost: clicks,
    totalSalesCount: sales.length,
  });

  return (
    <>
      <PageHeader title="分析 / 改善" description="同じ公開後経過時間で比較し、根拠付きで次の変更を決める" />

      {snapshots.length === 0 ? (
        <div className="card">
          <Empty title="反応データがまだありません">
            <div className="small">
              投稿が公開され、指標の取得が動き出すとここに反応が表示されます。
              取得できない指標は空欄のままで、0では埋めません。
            </div>
          </Empty>
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 16 }}>
            <span className="small muted">公開後の経過時間:</span>
            {ELAPSED_BUCKETS_HOURS.map((hours) => (
              <a key={hours} href={`/analysis?bucket=${hours}`}
                className={`btn small ${hours === bucket ? '' : 'secondary'}`}>
                {hours}時間
              </a>
            ))}
          </div>

          {comparisons.map((comparison) => (
            <div className="card" key={comparison.metric}>
              <h2>
                {METRIC_LABELS[comparison.metric]}
                <span className="sub">公開{comparison.bucketHours}時間後・カテゴリ別</span>
              </h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>カテゴリ</th>
                      <th className="num">件数</th>
                      <th className="num">欠測</th>
                      <th className="num">平均</th>
                      <th className="num">中央値</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.groups.map((group) => (
                      <tr key={group.label}>
                        <td>{group.label}</td>
                        <td className="num">{group.sampleSize}</td>
                        <td className="num">{group.missingCount > 0 ? group.missingCount : '—'}</td>
                        <td className="num">{group.mean === null ? '—' : group.mean.toFixed(1)}</td>
                        <td className="num">{group.median === null ? '—' : group.median.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {comparison.cautions.length > 0 && (
                <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {comparison.cautions.map((caution) => <li key={caution}>{caution}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <div className="card">
        <h2>売上への寄与</h2>
        {attribution.kind === 'unavailable' ? (
          <>
            <div className="notice">{attribution.reason}</div>
            {attribution.observedClicksByPost.size === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>観測されたクリックはまだありません。</p>
            ) : (
              <table>
                <thead><tr><th>投稿</th><th className="num">観測クリック数</th></tr></thead>
                <tbody>
                  {[...attribution.observedClicksByPost.entries()].map(([id, count]) => (
                    <tr key={id}><td className="mono">{id.slice(0, 8)}</td><td className="num">{count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </div>

      <div className="card">
        <h2>改善提案<span className="sub">採否は管理者が決める。自動では適用されない</span></h2>
        {proposals.length === 0 ? (
          <Empty title="提案はまだありません">
            <div className="small">
              反応データが集まると、観測事実・仮説・次回の変更点に分けた提案が作られます。
            </div>
          </Empty>
        ) : (
          proposals.map((proposal) => (
            <div key={proposal.id}
              style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <span className="badge">{proposal.state}</span>
                <span className="small muted">{formatJst(proposal.created_at)}</span>
              </div>
              <Section title="観測できた事実" items={proposal.observations} />
              <Section title="仮説（断定ではありません）" items={proposal.hypotheses} />
              <Section title="次回に変える点" items={proposal.changes} />
              {proposal.cautions.length > 0 && <Section title="注意" items={proposal.cautions} />}
              <p className="small muted">
                根拠: {proposal.evidence_ids.map((id) => id.slice(0, 8)).join(', ') || '—'}
              </p>
              {proposal.state === 'PENDING' && <ProposalActions id={proposal.id} />}
              {proposal.decided_note && (
                <p className="small muted">判断メモ: {proposal.decided_note}</p>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
