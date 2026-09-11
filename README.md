# AnyWare AI発信・販売管理

ThreadsとXでAI/Web制作に関する投稿を行い、無料教材・note販売商品へ誘導する。
投稿の反応を集計し、根拠付きの改善案を管理者が判断する。
操作はすべて日本語のダッシュボードから行う。

## 構成

- Next.js (App Router) + TypeScript
- PostgreSQL（`pg` を直接使用。ORMは入れていない）
- テストは Node の組み込みテストランナー（`node --test`）

TypeScript は Node 22.18 以降の型除去でそのまま実行する。ビルド手順は
Next.js のビルドのみで、テストや管理コマンドにビルドは不要。

## 必要なもの

- Node.js 22.18 以上
- PostgreSQL 14 以上（`gen_random_uuid()` のため `pgcrypto` を使う）

## 環境構築

```bash
npm install
cp .env.example .env.local   # 値を各自で設定する
```

`.env.example` は変数名だけを並べてある。最低限、次の2つが無いと起動できない。

| 変数 | 用途 |
| --- | --- |
| `DATABASE_URL` | 接続先。マネージドDBでは `DATABASE_SSL=require` も設定する |
| `TOKEN_ENCRYPTION_KEY` | 媒体トークンの暗号化キー。32バイトのbase64 |

キーの生成:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## マイグレーション

```bash
npm run migrate
```

`db/migrations/*.sql` を名前順に1回だけ適用する。適用済みは
`schema_migrations` に記録されるので、何度実行しても増えない。

## 初期データ

```bash
# 所有者アカウントを作る（パスワードは標準入力から読む）
npm run admin:create -- you@example.com "あなたの名前"

# 商品と知識を投入する（何度実行しても増えない）
npm run seed

# 既存の投稿を DRAFT として投入する
npm run import:posts
```

投入されるもの（すべてキット収録の実データ）:

| ファイル | 内容 |
| --- | --- |
| `content/products.json` | 販売案（Starter 1,980円 / 全10本 9,800円）と販売ページURL |
| `content/operator-facts.json` | **本人の経験3件。** 使えるのはこの3件だけ |
| `content/threads-90-posts.json` | 既存のThreads投稿90件 |
| `content/email-sequence.json` | 配信メール5通（Phase 4で使う） |
| `content/note-sales-copy.txt` | 販売原稿・プロフィール・固定投稿 |
| `content/cheat-sheet.txt` | 無料配布のチェックシート |

- 90投稿は**すべて DRAFT** で入る。元データの `day`/`time` は
  `suggested_slot` に目安として残すだけで、**予約日時にはしない**。
  承認もしない。X向けの文面は含まれない（別の下書きとして用意する）。
- 知識は `approved: true` のものだけ APPROVED で入る。
  **使ったAI名の組合せ・時間削減・受注数・売上改善・顧客名は補完しない。**
- どちらも元データのIDで冪等。何度実行しても増えない。

## 起動

```bash
npm run dev        # 開発
npm run build      # 本番ビルド
npm start          # 本番起動
```

`http://localhost:3000` を開くとログイン画面になる。
6画面（概要・投稿・カレンダー・分析/改善・商品/売上・設定）はすべて
認証で保護され、所有者のデータしか見えない。

## テスト

```bash
npm test            # 全部
npm run test:domain # DB不要（純粋関数のみ）
npm run test:db     # DBが必要
npm run typecheck
```

DBを使うテストは `TEST_DATABASE_URL`（`.env.local` に書ける）を読む。
未設定なら該当テストはスキップされる。**開発用DBとは別のDBを指定すること。
テストの前後でテーブルを TRUNCATE する。**

```
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/aiauto_test
```

HTTP経路の認証テスト（`tests/db/api-auth.test.ts`）は本番ビルドを起動して
実際にリクエストする。`npm run build` を先に実行していないとスキップされる。

`src/domain/policy.mjs` はキット収録の純粋関数で、**改変していない**。
`tests/kit/policy.test.mjs` の12件はそのまま通る。同じ規則をアプリ側でも
実装しているため、`tests/kit/cross-check.test.ts` で両者の判断が一致する
ことを確かめている。意図的な差分は `tests/kit/DIFFERENCES.md` に記録する。

## ワーカーと cron

投稿の送信、期限切れの処理、結果不明の隔離、指標の取得はワーカーが行う。

```bash
npm run worker         # 常駐
npm run worker:once    # 1巡だけ実行（cron向け）
```

cron（またはホスティングのスケジューラ）から5分おきに `worker:once` を
呼ぶ運用を想定している。

```
*/5 * * * * cd /path/to/app && npm run worker:once >> /var/log/aiops-worker.log 2>&1
```

**新旧のスケジューラーを同時に起動しないこと。** 同じ `WORKER_ID` を
複数起動しないこと。ジョブの取得はDBで直列化されるので二重投稿は起きないが、
運用上の混乱を避けるため。

## 費用の確認先

月次予算は既定で 10,000 円。内訳（AI 3,000 / X 3,000 / インフラ 2,000 /
予備 2,000）は**自社の予算配分であって、各社の料金ではない**。

有料呼出しは「見込額を予約 → 実行 → 実績で精算」の順に通る。
**料金表と為替レートが未登録のうちは、有料の自動処理は動かない。**
推測した単価で課金を進めないための仕様。登録は環境変数で行う。

| 変数 | 内容 |
| --- | --- |
| `AI_PRICE_INPUT_PER_MTOK` | 入力100万トークンあたりの単価 |
| `AI_PRICE_OUTPUT_PER_MTOK` | 出力100万トークンあたりの単価 |
| `AI_PRICE_CURRENCY` | 単価の通貨。`JPY` なら為替は不要 |
| `AI_FX_RATE_TO_JPY` | 1通貨あたりの円レート（JPY以外のとき必須） |

**単価は提供元の料金ページで確認して設定すること。** このリポジトリには
単価を書き込んでいない（古い値で課金判断をさせないため）。
提供元側の利用上限（ハードリミット）も別途設定すること。

実際の使用額は次で確認する。

- 概要画面の「運営費」… 当システムが把握している範囲の概算
- 各社の管理画面 … こちらが正
- `budget_reservations` テーブル … `UNSETTLED` は課金有無が不明なもの

費用の反映には提供元側の遅延がある。**「絶対に1万円を超えない」という表示は
行わない。** 80%で警告し、枠を超える予約は拒否する。

### 課金有無が不明な予約の後始末

5xx や応答なしで終わった呼出しは `UNSETTLED` として枠を塞いだままになる。
提供元の明細で確認したうえで、手動で決着させる。

```sql
-- 課金されていなかった場合
UPDATE budget_reservations
   SET state = 'RELEASED', reserved_yen = 0, settled_at = now()
 WHERE id = '<予約ID>';

-- 課金されていた場合（実績額を入れる）
UPDATE budget_reservations
   SET state = 'SETTLED', settled_yen = <実績円>, reserved_yen = 0, settled_at = now()
 WHERE id = '<予約ID>';
```

## 媒体の接続

```bash
npm run account:connect -- threads simulated
npm run account:connect -- x live <あなたのユーザーID>   # トークンは標準入力
```

- `disconnected` … 未接続。送信しない。
- `simulated` … 模擬接続。**外部へ一切送信しない。** 動作確認用。
  これで動いたことを「投稿できた」と報告してはいけない。
- `live` … 本番接続。実際に投稿される。

トークンは暗号化して保存し、画面には表示しない（保存の有無だけを示す）。

## 停止と復旧

設定画面に停止フラグがある（全体 / Threads / X / メール）。
**初期状態はすべて停止**。

- 停止は**送信の直前にも**確認される。停止すれば以降の送信は行われない。
- **停止前にすでに外部へ送信された処理は取り消せない。** その場合は結果が
  記録され、結果が不明なものは再送されず `UNKNOWN` として隔離される。
- `UNKNOWN` の投稿は自動で再送しない。外部の公開状態を照合して初めて
  「公開済み」か「失敗」に確定する。照合できないうちは `UNKNOWN` のまま。

緊急停止（画面が使えない場合）:

```sql
UPDATE settings SET global_stop = true WHERE owner_id = '<所有者ID>';
```

ワーカーを止める場合は `SIGTERM` を送る。処理中のものを終えてから停止する。

復旧の手順:

1. 停止フラグを解除する前に、`UNKNOWN` の投稿を確認して決着させる
2. 期限切れ（`EXPIRED`）は自動で再送されない。作り直すか再承認する
3. 予約が消えている場合は、承認済みの状態から予約し直す

## 運営上の上限

| 項目 | 値 |
| --- | --- |
| 媒体ごとの1日（JST）の投稿数 | 3件 |
| 同一媒体の投稿間隔 | 2時間以上 |
| 予約の猶予 | 24時間。過ぎたら `EXPIRED` |
| claim のリース | 5分 |

**これは運営上の自主的な上限であって、各媒体のAPI上限ではない。**

## 日時と金額の扱い

- 日時はすべて `timestamptz` で **UTC保存**。表示は **JST**（+09:00固定）。
- 金額はすべて **整数の円**。浮動小数点を使わない。
- 取得できなかった指標は **NULL のまま**。0で埋めない。
- 販売手数料が未入力のうちは、**税引前収支を確定値として表示しない**。

## ディレクトリ

```
db/migrations/     スキーマ
reference/         試作GAS（参考用。新システムのcronと並行稼働させない）
scripts/           migrate / seed / import-posts / admin / account / worker
src/domain/        純粋関数（DB・ネットワークに依存しない）
src/db/            リポジトリ層（すべて所有者スコープ）
src/adapters/      Threads / X / 指標取得
src/worker/        送信・照合・指標取得
src/ai/            料金計算とAnthropic API呼出し
src/app/           画面とAPI
tests/domain/      DB不要のテスト
tests/db/          DBが必要なテスト
tests/kit/         キット収録の純粋関数テストと、実装との突き合わせ
content/           商品・知識・既存投稿の投入元
```
