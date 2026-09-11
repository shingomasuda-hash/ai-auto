-- 知識を元データのIDで冪等に投入できるようにする。
-- content/operator-facts.json の id をそのまま持つ。

ALTER TABLE knowledge ADD COLUMN source_key text;

CREATE UNIQUE INDEX knowledge_source_key_key
  ON knowledge (owner_id, source_key)
  WHERE source_key IS NOT NULL;

COMMENT ON COLUMN knowledge.source_key IS
  '元データの識別子(例: operator-01)。再投入しても増やさないための鍵。';
