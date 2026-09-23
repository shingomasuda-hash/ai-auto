-- 送信枠の予約。
--
-- 「直近24時間に何件送ったか」を数えてから送る、という手順は
-- 検査と送信のあいだに割り込まれる。cron が重なったり、手元の
-- worker と同時に動いたりすると、どちらも「まだ0件」と判断して
-- 両方が送ってしまい、2時間間隔の運営上限が破れる。
--
-- そこで、送信の直前に「枠」を原子的に取る。取れなかったら送らない。
-- 枠は媒体ごとに直列化する。

CREATE TABLE send_slot_anchors (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('threads', 'x')),
  PRIMARY KEY (owner_id, platform)
);

COMMENT ON TABLE send_slot_anchors IS
  '媒体ごとの直列化のための行。この行を FOR UPDATE でロックしてから枠を数える。';

CREATE TABLE send_slot_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('threads', 'x')),
  variant_id  uuid REFERENCES post_variants(id) ON DELETE SET NULL,
  -- 枠を取った時刻。上限の計算はこの時刻で行う。
  reserved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX send_slot_window_idx
  ON send_slot_reservations (owner_id, platform, reserved_at DESC);

COMMENT ON TABLE send_slot_reservations IS
  '送信枠を取った記録。送信の成否に関わらず残す。外部へ届いた可能性がある以上、枠は消費したものとして扱う。';
