/**
 * 指標取得のアダプター。
 *
 * 取得できない指標は NULL のまま返す。0 で埋めない。
 * どの指標が取れるかは媒体と権限によって変わるため、
 * 本番接続の前に「実際に取得できる指標」と「呼出しの費用」を確認すること。
 */

import type { MetricValues } from '../domain/metrics.ts';
import type { Platform } from '../domain/text-length.ts';
import { requestJson, withTimeout } from './http.ts';
import { classifyTransportError } from './types.ts';

export type MetricsFetchResult =
  | { ok: true; values: MetricValues; raw: unknown }
  | { ok: false; reason: string };

export type MetricsAdapter = {
  platform: Platform;
  mode: 'live' | 'simulated';
  fetchMetrics(input: { externalPostId: string; signal: AbortSignal }): Promise<MetricsFetchResult>;
};

const EMPTY: MetricValues = {
  impressions: null, likes: null, replies: null, reposts: null, linkClicks: null,
};

/** 模擬接続。外部を呼ばず、指標は「取得できなかった」として NULL を返す。 */
export function createSimulatedMetricsAdapter(platform: Platform): MetricsAdapter {
  return {
    platform,
    mode: 'simulated',
    async fetchMetrics() {
      return { ok: true, values: { ...EMPTY }, raw: { simulated: true } };
    },
  };
}

function toIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

const THREADS_API_BASE = process.env.THREADS_API_BASE ?? 'https://graph.threads.net/v1.0';

export function createThreadsMetricsAdapter(accessToken: string): MetricsAdapter {
  return {
    platform: 'threads',
    mode: 'live',
    async fetchMetrics({ externalPostId, signal }) {
      const timeout = withTimeout(signal, 20_000);
      try {
        const result = await requestJson(
          `${THREADS_API_BASE}/${externalPostId}/insights?metric=views,likes,replies,reposts&access_token=${encodeURIComponent(accessToken)}`,
          { method: 'GET', signal: timeout.signal },
        );
        const data = (result.body as { data?: { name: string; values?: { value: unknown }[] }[] } | null)?.data;
        if (!Array.isArray(data)) return { ok: false, reason: '指標の応答形式が想定と異なります。' };

        const pick = (name: string) => {
          const entry = data.find((item) => item.name === name);
          return toIntOrNull(entry?.values?.[0]?.value);
        };
        return {
          ok: true,
          raw: result.body,
          values: {
            impressions: pick('views'),
            likes: pick('likes'),
            replies: pick('replies'),
            reposts: pick('reposts'),
            // クリックは媒体からは取れない。内部のクリックIDで別途数える。
            linkClicks: null,
          },
        };
      } catch (error) {
        return { ok: false, reason: classifyTransportError(error).detail };
      } finally {
        timeout.dispose();
      }
    },
  };
}

const X_API_BASE = process.env.X_API_BASE ?? 'https://api.x.com/2';

export function createXMetricsAdapter(accessToken: string): MetricsAdapter {
  return {
    platform: 'x',
    mode: 'live',
    async fetchMetrics({ externalPostId, signal }) {
      const timeout = withTimeout(signal, 20_000);
      try {
        const result = await requestJson(
          `${X_API_BASE}/tweets/${externalPostId}?tweet.fields=public_metrics`,
          { method: 'GET', signal: timeout.signal, headers: { authorization: `Bearer ${accessToken}` } },
        );
        const metrics = (result.body as {
          data?: { public_metrics?: Record<string, unknown> };
        } | null)?.data?.public_metrics;
        if (!metrics) return { ok: false, reason: '指標の応答形式が想定と異なります。' };

        return {
          ok: true,
          raw: result.body,
          values: {
            impressions: toIntOrNull(metrics.impression_count),
            likes: toIntOrNull(metrics.like_count),
            replies: toIntOrNull(metrics.reply_count),
            reposts: toIntOrNull(metrics.retweet_count),
            linkClicks: null,
          },
        };
      } catch (error) {
        return { ok: false, reason: classifyTransportError(error).detail };
      } finally {
        timeout.dispose();
      }
    },
  };
}
