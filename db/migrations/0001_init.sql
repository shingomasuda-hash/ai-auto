-- AnyWare AI発信・販売管理: 初期スキーマ
--
-- 方針:
--  * 金額はすべて integer の「円」。
--  * 日時はすべて timestamptz(UTC保存)。表示側でJSTへ変換する。
--  * 取得できない指標は NULL のまま。0 で埋めない。
--  * すべての業務テーブルに owner_id を持たせ、所有者スコープで参照・更新する。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- 認証

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  -- セッションIDそのものは保存せず、ハッシュだけを保存する。
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- 設定

CREATE TABLE settings (
  owner_id                uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 停止フラグ。送信直前に必ず読む。
  global_stop             boolean NOT NULL DEFAULT true,
  threads_stop            boolean NOT NULL DEFAULT true,
  x_stop                  boolean NOT NULL DEFAULT true,
  email_stop              boolean NOT NULL DEFAULT true,
  -- 初期はAI生成・自動承認とも無効。
  ai_generation_enabled   boolean NOT NULL DEFAULT false,
  auto_approve_enabled    boolean NOT NULL DEFAULT false,
  ai_model                text NOT NULL DEFAULT '',
  monthly_budget_yen      integer NOT NULL DEFAULT 10000 CHECK (monthly_budget_yen >= 0),
  monthly_goal_yen        integer NOT NULL DEFAULT 300000 CHECK (monthly_goal_yen >= 0),
  -- メールのテスト送信は指定宛先に限る。
  email_test_mode         boolean NOT NULL DEFAULT true,
  allowed_test_recipients text[] NOT NULL DEFAULT '{}',
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- 媒体の接続。トークンは値を画面へ出さない。
CREATE TABLE accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform          text NOT NULL CHECK (platform IN ('threads', 'x')),
  -- disconnected: 未接続 / simulated: 模擬接続(外部へ送らない) / live: 本番接続
  connection_mode   text NOT NULL DEFAULT 'disconnected'
                    CHECK (connection_mode IN ('disconnected', 'simulated', 'live')),
  display_name      text NOT NULL DEFAULT '',
  external_user_id  text,
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,
  scopes            text[] NOT NULL DEFAULT '{}',
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, platform)
);

-- ---------------------------------------------------------------- 知識・商品

CREATE TABLE knowledge (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- operator_experience(本人の経験) と general(一般ノウハウ) を必ず区別する。
  kind       text NOT NULL CHECK (kind IN ('operator_experience', 'general')),
  state      text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'APPROVED', 'ARCHIVED')),
  title      text NOT NULL,
  body       text NOT NULL,
  source     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_owner_idx ON knowledge (owner_id, state);

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  price_yen    integer NOT NULL CHECK (price_yen >= 0),
  note_url     text,
  -- 商品構成(例: 全10本にStarter3本を含む)を記録する。
  composition  jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_published boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, code)
);

-- ---------------------------------------------------------------- 投稿

-- 論理的な投稿(内容のまとまり)。媒体ごとの本文は post_variants に分離する。
CREATE TABLE posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT '',
  category   text NOT NULL CHECK (category IN (
               'intent_organizing', 'design_specification', 'quality_judgement',
               'general_tips', 'announcement')),
  cta_kind   text NOT NULL DEFAULT 'none'
             CHECK (cta_kind IN ('none', 'free_material', 'sales_page', 'note_product')),
  cta_url    text,
  -- manual: 手入力 / ai: AI生成 / import: 既存データ投入
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'import')),
  -- 既存データの冪等投入に使う。同じ鍵なら二重投入しない。
  import_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posts_cta_url_required CHECK (
    (cta_kind = 'none' AND cta_url IS NULL) OR (cta_kind <> 'none' AND cta_url IS NOT NULL)
  )
);
CREATE UNIQUE INDEX posts_import_key_key ON posts (owner_id, import_key) WHERE import_key IS NOT NULL;
CREATE INDEX posts_owner_idx ON posts (owner_id, created_at DESC);

CREATE TABLE post_variants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id      uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('threads', 'x')),
  body         text NOT NULL,
  state        text NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
                 'DRAFT', 'APPROVED', 'SCHEDULED', 'CLAIMED', 'PUBLISHING',
                 'PUBLISHED', 'FAILED', 'UNKNOWN', 'EXPIRED')),
  scheduled_at timestamptz,
  -- 承認時点の本文ハッシュ。本文が変われば再承認が必要になる。
  approved_body_hash text,
  approved_at  timestamptz,
  published_at timestamptz,
  -- 媒体側の投稿ID。媒体ごとに分離して保持する。
  external_post_id   text,
  -- Threadsのコンテナ状態など、媒体固有の状態。
  provider_state     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 重複検出用。送信の冪等性を保証するものではない。
  dedupe_hash  text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, platform),
  -- 予約状態には必ず予約日時がある。
  CONSTRAINT variants_scheduled_requires_time CHECK (
    state <> 'SCHEDULED' OR scheduled_at IS NOT NULL
  ),
  -- 公開済みには必ず外部IDと公開日時がある。
  CONSTRAINT variants_published_requires_external CHECK (
    state <> 'PUBLISHED' OR (external_post_id IS NOT NULL AND published_at IS NOT NULL)
  )
);
CREATE INDEX variants_owner_state_idx ON post_variants (owner_id, state);
CREATE INDEX variants_schedule_idx ON post_variants (owner_id, platform, scheduled_at);
-- 同じ媒体で同じ外部投稿IDを二重に記録しない。
CREATE UNIQUE INDEX variants_external_id_key
  ON post_variants (owner_id, platform, external_post_id)
  WHERE external_post_id IS NOT NULL;

-- 投稿がどの知識を参照したかを追跡可能にする。
CREATE TABLE post_knowledge_refs (
  variant_id   uuid NOT NULL REFERENCES post_variants(id) ON DELETE CASCADE,
  knowledge_id uuid NOT NULL REFERENCES knowledge(id) ON DELETE RESTRICT,
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (variant_id, knowledge_id)
);

-- 送信の試行。外部へ送る「前」に必ず1行入れる。
CREATE TABLE publish_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant_id       uuid NOT NULL REFERENCES post_variants(id) ON DELETE CASCADE,
  attempt_no       integer NOT NULL CHECK (attempt_no >= 1),
  -- 外部APIへ渡す冪等キー。同じ試行を二度送らないための鍵。
  idempotency_key  text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  outcome          text CHECK (outcome IN ('PUBLISHED', 'FAILED', 'UNKNOWN')),
  external_post_id text,
  error_code       text,
  error_detail     text,
  -- 停止前に外部へ送信済みだったかどうかを後から判別するために残す。
  sent_to_provider boolean NOT NULL DEFAULT false,
  UNIQUE (variant_id, attempt_no),
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX attempts_variant_idx ON publish_attempts (variant_id, started_at DESC);

-- ---------------------------------------------------------------- ジョブ

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('publish', 'collect_metrics', 'reconcile', 'email_step')),
  ref_id            uuid NOT NULL,
  state             text NOT NULL DEFAULT 'READY'
                    CHECK (state IN ('READY', 'CLAIMED', 'DONE', 'FAILED', 'CANCELLED')),
  run_after         timestamptz NOT NULL DEFAULT now(),
  claimed_by        text,
  claimed_at        timestamptz,
  -- claim には必ず期限を付ける。期限切れは回収して UNKNOWN 隔離の対象にする。
  claim_expires_at  timestamptz,
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_claim_fields CHECK (
    (state <> 'CLAIMED') OR (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
  )
);
-- 同じ対象に対する未完了ジョブは1件だけ。
CREATE UNIQUE INDEX jobs_active_ref_key ON jobs (owner_id, kind, ref_id)
  WHERE state IN ('READY', 'CLAIMED');
CREATE INDEX jobs_ready_idx ON jobs (state, run_after) WHERE state = 'READY';
CREATE INDEX jobs_lease_idx ON jobs (state, claim_expires_at) WHERE state = 'CLAIMED';

-- ---------------------------------------------------------------- 指標・改善

CREATE TABLE metric_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant_id          uuid NOT NULL REFERENCES post_variants(id) ON DELETE CASCADE,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  -- 公開後の経過時間バケット(時間)。比較は必ず同じバケット同士で行う。
  elapsed_bucket_hours integer,
  -- 取得できなかった指標は NULL のまま残す。
  impressions         integer,
  likes               integer,
  replies             integer,
  reposts             integer,
  link_clicks         integer,
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (variant_id, elapsed_bucket_hours)
);
CREATE INDEX snapshots_owner_idx ON metric_snapshots (owner_id, captured_at DESC);

CREATE TABLE improvement_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  -- 観測事実・仮説・次回の変更点を分けて保持する。
  observations jsonb NOT NULL,
  hypotheses   jsonb NOT NULL,
  changes      jsonb NOT NULL,
  evidence_ids jsonb NOT NULL,
  cautions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_at   timestamptz,
  decided_note text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_owner_idx ON improvement_proposals (owner_id, state, created_at DESC);

-- ---------------------------------------------------------------- 売上・費用

CREATE TABLE sales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 販売元が発行する注文ID。所有者スコープで一意。重複取込を防ぐ。
  external_order_id text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('SALE', 'REFUND')),
  product_code      text NOT NULL,
  gross_yen         integer NOT NULL CHECK (gross_yen >= 0),
  -- 手数料が不明なら NULL。NULL のまま利益を確定表示しない。
  fee_yen           integer CHECK (fee_yen IS NULL OR fee_yen >= 0),
  occurred_at       timestamptz NOT NULL,
  -- 入金日は売上計上日と区別する。未入金なら NULL。
  settled_on        timestamptz,
  note              text,
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, external_order_id)
);
CREATE INDEX sales_owner_occurred_idx ON sales (owner_id, occurred_at DESC);

CREATE TABLE expense_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('ai', 'x_api', 'infra', 'reserve')),
  amount_yen  integer NOT NULL CHECK (amount_yen >= 0),
  incurred_on timestamptz NOT NULL,
  memo        text NOT NULL DEFAULT '',
  -- 固定料金は月初に予算から先に差し引く。
  is_fixed    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_owner_idx ON expense_entries (owner_id, incurred_on DESC);

-- 月次・枠ごとの上限。予約時にこの行を FOR UPDATE でロックして直列化する。
CREATE TABLE budget_envelopes (
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_key  text NOT NULL CHECK (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  category   text NOT NULL CHECK (category IN ('ai', 'x_api', 'infra', 'reserve')),
  limit_yen  integer NOT NULL CHECK (limit_yen >= 0),
  fixed_yen  integer NOT NULL DEFAULT 0 CHECK (fixed_yen >= 0),
  PRIMARY KEY (owner_id, month_key, category)
);

CREATE TABLE budget_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_key    text NOT NULL,
  category     text NOT NULL CHECK (category IN ('ai', 'x_api', 'infra', 'reserve')),
  state        text NOT NULL DEFAULT 'RESERVED'
               CHECK (state IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNSETTLED')),
  -- 有料呼出し前に確保する最大見込額(SDKの暗黙リトライ分を含む)。
  reserved_yen integer NOT NULL CHECK (reserved_yen >= 0),
  -- 精算後の実績。未精算なら 0。
  settled_yen  integer NOT NULL DEFAULT 0 CHECK (settled_yen >= 0),
  purpose      text NOT NULL,
  ref_id       uuid,
  -- 二重予約を防ぐ鍵。
  idempotency_key text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  note         text NOT NULL DEFAULT '',
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, month_key, category)
    REFERENCES budget_envelopes (owner_id, month_key, category) ON DELETE RESTRICT
);
CREATE INDEX reservations_open_idx ON budget_reservations (owner_id, month_key, category, state);

-- ---------------------------------------------------------------- 導線・メール

CREATE TABLE click_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 内部クリックID。購入と1件単位で結び付くとは限らない。
  click_id    text NOT NULL,
  variant_id  uuid REFERENCES post_variants(id) ON DELETE SET NULL,
  utm         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, click_id)
);
CREATE INDEX clicks_variant_idx ON click_events (variant_id, occurred_at);

CREATE TABLE subscribers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email                 text NOT NULL,
  state                 text NOT NULL DEFAULT 'PENDING'
                        CHECK (state IN ('PENDING', 'CONFIRMED', 'UNSUBSCRIBED', 'BOUNCED')),
  consent_text_version  text,
  consented_at          timestamptz,
  confirmed_at          timestamptz,
  unsubscribed_at       timestamptz,
  -- トークンは平文で保存しない。
  confirm_token_hash    text,
  unsubscribe_token_hash text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, email),
  -- 確認済みには必ず確認日時がある(GETだけで有効化されていないことの担保)。
  CONSTRAINT subscribers_confirmed_requires_time CHECK (
    state <> 'CONFIRMED' OR confirmed_at IS NOT NULL
  )
);

CREATE TABLE consents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscriber_id        uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  event                text NOT NULL CHECK (event IN ('subscribe', 'confirm', 'unsubscribe', 'bounce')),
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  consent_text_version text,
  ip                   inet,
  user_agent           text
);
CREATE INDEX consents_subscriber_idx ON consents (subscriber_id, occurred_at);

CREATE TABLE email_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscriber_id       uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  step_key            text NOT NULL,
  status              text NOT NULL DEFAULT 'SENDING'
                      CHECK (status IN ('SENDING', 'SENT', 'FAILED', 'UNKNOWN')),
  sent_at             timestamptz,
  provider_message_id text,
  error_detail        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- 同じ相手に同じステップを二度配信しない。
  UNIQUE (subscriber_id, step_key)
);

-- ---------------------------------------------------------------- 監査

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  owner_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor       text NOT NULL,
  action      text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id   text NOT NULL DEFAULT '',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_owner_idx ON audit_logs (owner_id, created_at DESC);
