-- キット収録の90投稿が使っているカテゴリを追加する。
--
-- howto / prompt / check / cta は既存投稿の実際の分類。
-- 商品の3軸に由来する既存の分類と併存させ、取り込み時に
-- 元のカテゴリを勝手に読み替えない。

ALTER TABLE posts DROP CONSTRAINT posts_category_check;

ALTER TABLE posts ADD CONSTRAINT posts_category_check CHECK (category IN (
  -- 商品の軸に対応する分類
  'intent_organizing', 'design_specification', 'quality_judgement',
  'general_tips', 'announcement',
  -- 既存90投稿の分類（reference の試作と同じ語）
  'howto', 'prompt', 'check', 'cta'
));

-- 元データが持っていた投稿時間帯の目安。
-- これは「予約」ではない。勝手に公開・予約しないこと。
ALTER TABLE posts ADD COLUMN suggested_slot text;

COMMENT ON COLUMN posts.suggested_slot IS
  '元データの投稿時間帯の目安(例: D01 08:10)。予約ではない。';
