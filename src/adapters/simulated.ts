/**
 * 模擬接続。外部へ一切送信しない。
 *
 * 本番接続の認可が下りるまでの動作確認に使う。
 * 実際の投稿は行われないので、これを「投稿できた」と報告してはいけない。
 */
import type { PublishAdapter, PublishOutcome, ReconcileOutcome } from './types.ts';
import type { Platform } from '../domain/text-length.ts';
import { contentHash } from '../lib/crypto.ts';

export function createSimulatedAdapter(platform: Platform): PublishAdapter {
  const published = new Map<string, string>();
  return {
    platform,
    mode: 'simulated',
    async publish(request): Promise<PublishOutcome> {
      const externalPostId = `sim-${platform}-${contentHash(request.idempotencyKey).slice(0, 16)}`;
      published.set(request.idempotencyKey, externalPostId);
      return {
        outcome: 'PUBLISHED',
        externalPostId,
        providerState: { simulated: true, at: new Date().toISOString() },
      };
    },
    async reconcile(request): Promise<ReconcileOutcome> {
      const externalPostId = published.get(request.idempotencyKey);
      return externalPostId ? { found: true, externalPostId } : { found: false };
    },
  };
}
