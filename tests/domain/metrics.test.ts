import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareGroups, bucketOf, latestPerPost, attributeSales, MIN_SAMPLES_FOR_COMPARISON } from '../../src/domain/metrics.ts';
import type { Snapshot } from '../../src/domain/metrics.ts';
import { HOUR_MS } from '../../src/domain/time.ts';

const publishedAt = new Date('2026-04-01T00:00:00Z');

function snap(postId: string, elapsedHours: number, values: Partial<Snapshot['values']>): Snapshot {
  return {
    postId,
    publishedAt,
    capturedAt: new Date(publishedAt.getTime() + elapsedHours * HOUR_MS),
    values: { impressions: null, likes: null, replies: null, reposts: null, linkClicks: null, ...values },
  };
}

test('経過時間をバケットへ割り当てる', () => {
  assert.equal(bucketOf(snap('a', 24, {})), 24);
  assert.equal(bucketOf(snap('a', 25.5, {})), 24);
  assert.equal(bucketOf(snap('a', 40, {})), null);
  assert.equal(bucketOf(snap('a', 72, {})), 72);
});

test('同一バケットで投稿ごとの最新を1件選ぶ', () => {
  const chosen = latestPerPost([snap('a', 23, { likes: 1 }), snap('a', 25, { likes: 5 })], 24);
  assert.equal(chosen.size, 1);
  assert.equal(chosen.get('a')?.values.likes, 5);
});

test('経過時間がそろわないスナップショットは比較に混ぜない', () => {
  const result = compareGroups(
    [snap('a', 24, { likes: 10 }), snap('b', 72, { likes: 100 })],
    [{ postId: 'a', label: 'A' }, { postId: 'b', label: 'B' }],
    'likes',
    24,
  );
  const groupB = result.groups.find((g) => g.label === 'B')!;
  assert.equal(groupB.sampleSize, 0);
  assert.equal(groupB.missingCount, 1);
  assert.equal(groupB.mean, null);
});

test('欠測を0として扱わない', () => {
  const result = compareGroups(
    [snap('a', 24, { likes: 10 }), snap('b', 24, { likes: null })],
    [{ postId: 'a', label: 'A' }, { postId: 'b', label: 'A' }],
    'likes',
    24,
  );
  const groupA = result.groups[0];
  assert.equal(groupA.sampleSize, 1);
  assert.equal(groupA.missingCount, 1);
  assert.equal(groupA.mean, 10); // 0で薄まらない
  assert.equal(result.cautions.some((c) => c.includes('欠測')), true);
});

test('標本が少なければ断定しない', () => {
  const result = compareGroups(
    [snap('a', 24, { likes: 10 }), snap('b', 24, { likes: 2 })],
    [{ postId: 'a', label: 'A' }, { postId: 'b', label: 'B' }],
    'likes',
    24,
  );
  assert.equal(result.conclusive, false);
  assert.equal(result.cautions.some((c) => c.includes('断定')), true);
});

test('いいね数のみでは評価しないという注意が必ず付く', () => {
  const snapshots: Snapshot[] = [];
  const posts = [];
  for (let i = 0; i < MIN_SAMPLES_FOR_COMPARISON * 2; i += 1) {
    const id = `p${i}`;
    snapshots.push(snap(id, 24, { likes: i, linkClicks: i }));
    posts.push({ postId: id, label: i % 2 === 0 ? 'A' : 'B' });
  }
  const likes = compareGroups(snapshots, posts, 'likes', 24);
  assert.equal(likes.cautions.some((c) => c.includes('いいね')), true);
  assert.equal(likes.conclusive, false);

  const clicks = compareGroups(snapshots, posts, 'linkClicks', 24);
  assert.deepEqual(clicks.cautions, []);
  assert.equal(clicks.conclusive, true);
});

test('1群しかなければ比較できない', () => {
  const result = compareGroups([snap('a', 24, { likes: 1 })], [{ postId: 'a', label: 'A' }], 'linkClicks', 24);
  assert.equal(result.cautions.some((c) => c.includes('2群')), true);
  assert.equal(result.conclusive, false);
});

test('平均と中央値の両方を出す', () => {
  const result = compareGroups(
    [snap('a', 24, { linkClicks: 1 }), snap('b', 24, { linkClicks: 2 }), snap('c', 24, { linkClicks: 99 })],
    [{ postId: 'a', label: 'A' }, { postId: 'b', label: 'A' }, { postId: 'c', label: 'A' }],
    'linkClicks',
    24,
  );
  assert.equal(result.groups[0].mean, 34);
  assert.equal(result.groups[0].median, 2);
});

test('購入と投稿を紐付けられないなら寄与は不明のまま', () => {
  const clicks = new Map([['a', 10], ['b', 3]]);
  const result = attributeSales({ perPurchaseLinkAvailable: false, clicksByPost: clicks, totalSalesCount: 5 });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.kind === 'unavailable' && result.observedClicksByPost.get('a'), 10);
  assert.match(result.kind === 'unavailable' ? result.reason : '', /購入寄与としては扱いません/);
});
