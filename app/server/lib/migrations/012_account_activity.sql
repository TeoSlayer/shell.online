-- The days on which an account used the app, so the statistics dashboard can
-- say how many accounts are active and how many come back after signing up.
--
-- One row per account per day and nothing else: no route, no action, no
-- address. last_seen_at on the membership is the same fact at finer grain,
-- and is what keeps the write cheap: a request only touches these when the
-- membership has not been touched for a while. Both are deleted with the
-- account; the days are dropped after 400 days regardless.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;

CREATE TABLE IF NOT EXISTS account_activity (
  uid  TEXT   NOT NULL,
  day  BIGINT NOT NULL,
  PRIMARY KEY (uid, day)
);

CREATE INDEX IF NOT EXISTS account_activity_day ON account_activity (day);
