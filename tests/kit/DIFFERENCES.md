# キットの試作(policy.mjs)とアプリ実装の差分

`src/domain/policy.mjs` はキット収録の純粋関数で、**そのまま維持している**
（`tests/kit/policy.test.mjs` の12件も未改変で通る）。
アプリ本体は `src/domain/*.ts` に実装があり、同じ規則を扱う箇所がある。

二重管理は放っておけば必ずずれるので、`tests/kit/cross-check.test.ts` で
両者の判断が一致することを確かめている。以下は**意図的に違う点**の記録。
ここに書いていない不一致が出たら、それはバグ。

## 1. 上限の数え方 — キットに合わせた（アプリ側を変更）

当初アプリはJSTの暦日で「1日3件」を数えていた。キットの試作は
**直近24時間の移動窓**で数えている。移動窓が正しい。

暦日で数えると、JST 23:00 に3件・翌 00:30 に3件が通り、実質2時間半で
6件になる。移動窓ならこれを防げる。アプリ側を移動窓へ変更した。

- `POLICY.maxPostsPerPlatformPer24h` / `POLICY.rateWindowMs`
- 検証: `tests/domain/policy.test.ts`「上限は暦日ではなく移動窓で数える」

## 2. 送信直前の上限判定 — アプリ側に追加（キットに合わせた）

当初アプリは**予約時にしか**上限を見ていなかった。予約が遅延したり、
予約後に別の投稿が公開されたりすると、予約時点の前提が崩れる。
キットの `scheduleDecision` は送信時に実績で判定している。

アプリの `evaluateSendGate` に `recentPublishedAt` を足し、
**実際に公開された時刻**で数え直すようにした。上限に当たった場合は
窓が空く時刻(`retryAt`)まで待ってから再試行する。

- 検証: `tests/domain/policy.test.ts`「送信直前ゲート: 実績の件数でも上限を守る」

## 3. 遷移表 — アプリ側が意図的に広い

キットの遷移表は担当者の区別を持たない。アプリは
`owner / worker / reconciler / scheduler` を区別するため、
同じ遷移でも担当によって可否が変わる。

アプリだけが許す遷移（すべて管理者または照合処理に限定）:

| 遷移 | 担当 | 理由 |
| --- | --- | --- |
| `SCHEDULED → APPROVED` | owner | 予約取消。承認は保持する（キットは DRAFT へ戻す） |
| `FAILED → SCHEDULED` | owner | 管理者による再予約 |
| `EXPIRED → APPROVED` | owner | 内容そのままで再承認 |
| `UNKNOWN → PUBLISHED` | reconciler | 照合の結果としてのみ |
| `UNKNOWN → FAILED` | reconciler | 照合の結果としてのみ |

**キットが `UNKNOWN: []` としている意図は保っている。** アプリでも
`worker` と `scheduler` は UNKNOWN から何も動かせない。動かせるのは
外部と照合した `reconciler` だけで、これはキットの `reconcileUnknown()`
が別関数として同じことをしているのと同じ。

- 検証: `tests/kit/cross-check.test.ts`「UNKNOWN から送信側へ戻す経路が、どちらにも無い」

## 4. 照合で「未公開」と分かったときの行き先

- キット: `reconcileUnknown({outcome:'confirmed_not_published'})` → `DRAFT`
- アプリ: `UNKNOWN → FAILED`（`last_error` に理由を残す）

アプリは `FAILED → DRAFT` を許しているので、管理者の操作で同じ場所へ
行ける。失敗の記録を1段階残すぶんアプリ側が詳しい。実質の差はない。

## 5. 投稿のカテゴリ

キットの90投稿は `howto / prompt / check / cta` を使っている。
アプリは商品の3軸（意図整理・デザイン具体化・品質判断）由来の分類を
持っていた。**どちらも捨てずに両方を有効な値として扱う**
（`db/migrations/0002_kit_categories.sql`）。
取り込んだ90投稿は元のカテゴリのまま保持する。

## 6. 生成時の文字数

`reference/Code.gs` の生成プロンプトは `<=350 Unicode characters` を
指示している。これは媒体の上限(Threads 500)ではなく、**試作が自主的に
置いた制限**。アプリは媒体の上限で検証し、生成側の目安は別に扱う。
