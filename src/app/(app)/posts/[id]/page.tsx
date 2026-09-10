import { notFound } from 'next/navigation';
import { requireOwner } from '../../../../lib/session.ts';
import { getVariant, getKnowledgeRefs } from '../../../../db/posts.ts';
import { listAccounts } from '../../../../db/settings.ts';
import { formatJst } from '../../../../domain/time.ts';
import { allowedTransitions } from '../../../../domain/post-state.ts';
import { PageHeader, StateBadge, PlatformLabel } from '../../_ui.tsx';
import PostDetail from './PostDetail.tsx';

export const dynamic = 'force-dynamic';

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;

  // 所有者スコープで取得する。他人の投稿は存在しないものとして扱う。
  const variant = await getVariant(user.id, id);
  if (!variant) notFound();

  const [refs, accounts] = await Promise.all([
    getKnowledgeRefs(user.id, variant.id),
    listAccounts(user.id),
  ]);
  const account = accounts.find((a) => a.platform === variant.platform);

  return (
    <>
      <PageHeader title="投稿の詳細" description={`${variant.platform === 'x' ? 'X' : 'Threads'} 向けの本文`} />

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="row">
            <PlatformLabel platform={variant.platform} />
            <StateBadge state={variant.state} />
          </div>
          <div className="small muted">
            作成 {formatJst(variant.created_at)}
          </div>
        </div>

        {account?.connection_mode === 'disconnected' && (
          <div className="notice warn">
            {variant.platform === 'x' ? 'X' : 'Threads'} は未接続です。予約はできますが、接続するまで送信されません。
          </div>
        )}
        {variant.state === 'UNKNOWN' && (
          <div className="notice bad">
            送信結果が不明です。再送はしません。外部の公開状態を照合してから、公開済み／失敗を確定してください。
            {variant.last_error && <div className="mono" style={{ marginTop: 6 }}>{variant.last_error}</div>}
          </div>
        )}
        {variant.state === 'EXPIRED' && (
          <div className="notice">
            予約時刻から24時間以上経過したため期限切れになりました。まとめて投稿し直すことはありません。
          </div>
        )}
        {variant.state === 'FAILED' && variant.last_error && (
          <div className="notice bad"><span className="mono">{variant.last_error}</span></div>
        )}

        <PostDetail
          variant={{
            id: variant.id,
            platform: variant.platform,
            body: variant.body,
            state: variant.state,
            scheduledAt: variant.scheduled_at ? variant.scheduled_at.toISOString() : null,
          }}
          ownerActions={allowedTransitions(variant.state, 'owner')}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>この投稿の情報</h2>
          <table>
            <tbody>
              <tr><th>カテゴリ</th><td>{variant.category}</td></tr>
              <tr><th>CTA</th><td>{variant.cta_kind === 'none' ? 'なし' : `${variant.cta_kind} / ${variant.cta_url}`}</td></tr>
              <tr><th>作成元</th><td>{variant.source}</td></tr>
              <tr><th>承認日時</th><td>{formatJst(variant.approved_at)}</td></tr>
              <tr><th>予約日時</th><td>{formatJst(variant.scheduled_at)}</td></tr>
              <tr><th>公開日時</th><td>{formatJst(variant.published_at)}</td></tr>
              <tr>
                <th>媒体側の投稿ID</th>
                <td className="mono">{variant.external_post_id ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>参照した知識</h2>
          {refs.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>参照元が登録されていません。</p>
          ) : (
            <table>
              <tbody>
                {refs.map((ref) => (
                  <tr key={ref.id}>
                    <td>{ref.title}</td>
                    <td>
                      <span className="badge">
                        {ref.kind === 'operator_experience' ? '本人の経験' : '一般'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
