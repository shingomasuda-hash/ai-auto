# 定期実行の設定

予約投稿の送信、期限切れの処理、結果不明の照合、指標の取得は
`POST /api/cron/tick`（`GET` も可）を定期的に叩くことで動く。

叩かないかぎり何も起きない。**予約しただけでは投稿されない。**

## 認可

`CRON_SECRET` を設定する（16文字以上）。未設定のあいだ、この入口は
誰にも応答しない（503を返す）。設定し忘れを素通しにしない。

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

受け付けるヘッダは2種類。

| ヘッダ | 用途 |
| --- | --- |
| `Authorization: Bearer <CRON_SECRET>` | Vercel の cron が自動で付ける形式 |
| `x-cron-secret: <CRON_SECRET>` | Authorization を付けられない外部サービス向け |

## 1回の呼び出しでやること

時間と件数の上限で区切る。上限に達したら、新しいジョブに手を付けずに戻る。
残りは次の呼び出しで拾うので、取りこぼしにはならない。

| 環境変数 | 既定 | 意味 |
| --- | --- | --- |
| `CRON_BUDGET_MS` | 45000 | この時間を超えたら新しいジョブを始めない |
| `CRON_MAX_JOBS` | 25 | 1回で処理するジョブ数の上限 |

実行中のジョブは途中で切らないので、実際の所要時間は budget より
長くなりうる。ホスティングの実行時間上限より十分小さく取ること。
上限に当たって途中で殺されると、送信中の処理が `UNKNOWN` として
隔離され、外部と照合する手間が増える。

## 呼び出しの間隔

**運営上限が別にあるので、頻繁に叩いても投稿は増えない。**
媒体ごとに24時間で3件、同一媒体は2時間以上あける。1回の呼び出しで
送信されるのは、条件を満たした1件だけ。

したがって必要な頻度は「予約時刻にどれだけ近く送りたいか」で決まる。

| 間隔 | 予約時刻からの遅れ |
| --- | --- |
| 5分 | 最大5分 |
| 1時間 | 最大1時間 |
| 1日 | 最大1日（実質使えない） |

## Vercel の cron を使う場合

`vercel.json` に設定済み。ただし**プランによる制限がある**。

| プラン | cron の頻度 |
| --- | --- |
| Hobby（無料） | **1日1回まで。** これより頻繁な設定は deploy が失敗する |
| Pro | 分単位 |

収録している `vercel.json` は **1日1回**（`0 9 * * *` = JST 18:00）に
してある。Hobby でも deploy が通る設定で、これが安全網になる。

**ただし1日1回では実用にならない。** 予約した投稿が最大24時間待たされる。
毎時以上にしたい場合は、下の「外部のcronサービス」を使う。

> `vercel.json` の schedule を `*/5 * * * *` のように変えると、
> **Hobby では deploy そのものが失敗する。** Pro へ上げるまで変えないこと。

1日1回でも、期限切れの処理・結果不明の照合・指標の取得は進む。
投稿の送信だけが遅れる。

## 外部のcronサービスから叩く（Hobby向け）

運営費の上限が月10,000円で、Vercel Pro は月$20程度かかる。
外部のcronサービスから叩くほうが枠に収まりやすい。

```
URL:     https://<あなたのURL>/api/cron/tick
Method:  POST
Header:  x-cron-secret: <CRON_SECRET>
間隔:     5〜15分
```

使う前に、そのサービスの現在の料金と無料枠を確認すること。
このリポジトリに単価は書かない。

`vercel.json` の `crons` は削除するか、1日1回に落としておく。
**同じ処理を二重に走らせても二重投稿にはならない**（送信枠を原子的に
取るため）が、無駄な呼び出しになる。

## 手元から叩く / 手動で動かす

```bash
npm run worker:once     # 1巡だけ
npm run worker          # 常駐（開発時）
```

`.env.local` の `DATABASE_URL` が本番を指していれば、手元からでも
本番の予約を処理できる。cron と同時に走っても二重投稿にはならない。

## 動作確認

```bash
curl -X POST https://<あなたのURL>/api/cron/tick \
  -H "x-cron-secret: <CRON_SECRET>"
```

返ってくる `summary` で何をしたか分かる。

```json
{
  "ok": true,
  "summary": {
    "expired": [], "released": 0, "quarantined": [],
    "published": 1, "failed": 0, "unknown": 0, "skipped": 2,
    "metricsCaptured": 0, "reconciled": 0,
    "processed": 3, "budgetExhausted": false, "durationMs": 412
  }
}
```

| 項目 | 意味 |
| --- | --- |
| `published` | 送信できた件数 |
| `skipped` | 停止中・上限・未接続などで見送った件数 |
| `unknown` | 送信結果が不明で隔離した件数。**再送されない** |
| `quarantined` | 送信中に期限切れして隔離した投稿 |
| `budgetExhausted` | true なら残りがある。次の呼び出しで処理される |

`401` が返る場合は `CRON_SECRET` が一致していない。
`503` が返る場合は `CRON_SECRET` が未設定。
