-- 販売チャネルを区別する。
--
-- note（教材の売り切り）と ココナラ（役務提供）は事業の軸が別で、
-- 納期・返金条件・原価の考え方が違う。同じ数字として混ぜると
-- 利益の内訳が読めなくなるため、チャネルと商品種別を分けて持つ。
--
-- 管理は一つの画面で行い、内訳だけを分ける。

ALTER TABLE sales ADD COLUMN channel text NOT NULL DEFAULT 'note'
  CHECK (channel IN ('note', 'coconala', 'other'));

ALTER TABLE products ADD COLUMN channel text NOT NULL DEFAULT 'note'
  CHECK (channel IN ('note', 'coconala', 'other'));

-- digital_product: 売り切りのデジタル商品（納品後の作業が発生しない）
-- service:         役務提供（制作代行・相談。納期と作業が発生する）
ALTER TABLE products ADD COLUMN kind text NOT NULL DEFAULT 'digital_product'
  CHECK (kind IN ('digital_product', 'service'));

-- 商品ページのURL。note_url はチャネル別の名前へ寄せず、
-- 既存の列をそのまま使い、チャネルで意味を切り替える。
COMMENT ON COLUMN products.note_url IS
  'このチャネルでの商品ページURL（note記事、ココナラ出品ページなど）。';

COMMENT ON COLUMN sales.channel IS
  '販売元。取込元のCSVごとに指定する。集計の内訳に使う。';

CREATE INDEX sales_channel_idx ON sales (owner_id, channel, occurred_at DESC);

-- 注文IDの一意制約はチャネルをまたいで効かせる。
-- 別チャネルで同じ注文IDが振られる可能性は低いが、
-- 万一衝突しても二重計上より弾く方が安全。既存の
-- sales_owner_id_external_order_id_key をそのまま使う。
