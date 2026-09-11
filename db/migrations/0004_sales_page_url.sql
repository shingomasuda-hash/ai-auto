-- 既存の販売ページのURL。CTAの許可先として使う。
-- ダッシュボードとは別物で、ここで生成側が新しいURLを作れないようにする。

ALTER TABLE settings ADD COLUMN sales_page_url text;
ALTER TABLE settings ADD COLUMN free_material_url text;

COMMENT ON COLUMN settings.sales_page_url IS
  '既存の販売ページ。AI生成のCTAはこことnoteリンクのみ許可する。';
