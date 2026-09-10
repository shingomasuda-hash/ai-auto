import { requireOwner } from '../../../../lib/session.ts';
import { listKnowledge } from '../../../../db/knowledge.ts';
import { PageHeader } from '../../_ui.tsx';
import PostForm from '../PostForm.tsx';

export const dynamic = 'force-dynamic';

export default async function NewPostPage() {
  const user = await requireOwner();
  const knowledge = await listKnowledge(user.id, 'APPROVED');

  return (
    <>
      <PageHeader title="投稿を作成" description="媒体ごとに別の本文として作成する" />
      <div className="card">
        <PostForm
          knowledge={knowledge.map((k) => ({ id: k.id, title: k.title, kind: k.kind }))}
        />
      </div>
    </>
  );
}
