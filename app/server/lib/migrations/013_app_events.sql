-- What accounts did in the app, counted by day and by kind and nothing else:
-- no account, no address, no session. The statistics dashboard reads totals
-- over a range from it, so it can say how many machines were linked or
-- commands sent next to how many accounts there are. Rows are dropped after
-- the same 400 days as activity days.
CREATE TABLE IF NOT EXISTS app_events (
  event TEXT    NOT NULL,
  day   BIGINT  NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event, day)
);

CREATE INDEX IF NOT EXISTS app_events_day ON app_events (day);
