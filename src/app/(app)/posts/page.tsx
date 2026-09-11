import Link from 'next/link';
import { requireOwner } from '../../../lib/session.ts';
import { listVariants } from '../../../db/posts.ts';
import { formatJst } from '../../../domain/time.ts';
import { PageHeader, StateBadge, PlatformLabel, Empty } from '../_ui.tsx';
import type { PostState } from '../../../domain/post-state.ts';
import type { Platform } from '../../../domain/text-length.ts';

export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<string, string> = {
  intent_organizing: '意図整理',
  design_specification: 'デザイン具体化',
  quality_judgement: '品質判断',
  general_tips: '一般ノウハウ',
  announcement: 'お知らせ',
};

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; state?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const platform = params.platform === 'x' || params.platform === 'threads' ? (params.platform as Platform) : undefined;
  const states = params.state ? ([params.state] as PostState[]) : undefined;

  const variants = await listVariants(user.id, { platform, states });

  return (
    <>
      <PageHeader title="投稿" description="媒体ごとの本文を下書き・承認・予約する" />

      <div className="row" style={{ marginBottom: 16, justifyContent: 'space-between' }}>
        <div className="row">
          <FilterLink href="/posts" label="すべて" active={!platform && !states} />
          <FilterLink href="/posts?platform=threads" label="Threads" active={platform === 'threads'} />
          <FilterLink href="/posts?platform=x" label="X" active={platform === 'x'} />
          <FilterLink href="/posts?state=DRAFT" label="下書き" active={params.state === 'DRAFT'} />
          <FilterLink href="/posts?state=SCHEDULED" label="予約済み" active={params.state === 'SCHEDULED'} />
        </div>
        <Link href="/posts/new" className="btn">新規作成</Link>
      </div>

      <div className="card">
        {variants.length === 0 ? (
          <Empty title="該当する投稿がありません">
            <div className="small">「新規作成」から下書きを作成できます。</div>
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>媒体</th>
                  <th>本文</th>
                  <th>カテゴリ</th>
                  <th>状態</th>
                  <th>予約/公開日時 (JST)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {variants.map((variant) => (
                  <tr key={variant.id}>
                    <td><PlatformLabel platform={variant.platform} /></td>
                    <td>
                      {/* 一覧では改行をつぶして1行で見せる。全文は詳細画面で読む。 */}
                      <div className="body-preview" title={variant.body}>
                        {preview(variant.body)}
                      </div>
                    </td>
                    <td className="small">{CATEGORY_LABELS[variant.category] ?? variant.category}</td>
                    <td><StateBadge state={variant.state} /></td>
                    <td className="small">
                      {formatJst(variant.published_at ?? variant.scheduled_at)}
                    </td>
                    <td><Link href={`/posts/${variant.id}`} className="btn secondary small">開く</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/** 一覧用の要約。改行と連続空白をつめて1行にする。 */
function preview(body: string, max = 78): string {
  const flat = body.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`;
}

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link href={href} className={`btn small ${active ? '' : 'secondary'}`}>{label}</Link>
  );
}
