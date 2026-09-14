-- What people tell us from inside the app.
--
-- One row per message, with where in the app it was written: the control that
-- opened the form, the route, the build and the browser, and a few facts the
-- control attached, such as which kind of session was being started. Nothing
-- from a terminal: the app never has the plaintext, and the form says so.
--
-- A message belongs to the service rather than to a team, so deleting the
-- account that sent it clears who sent it and keeps the words, the same way the
-- activity trail keeps what was typed.
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT    PRIMARY KEY,
  uid          TEXT    NOT NULL,
  email        TEXT    NOT NULL,
  org_id       TEXT,
  kind         TEXT    NOT NULL CHECK (kind IN ('problem', 'idea', 'question')),
  body         TEXT    NOT NULL,
  surface      TEXT    NOT NULL,
  route        TEXT    NOT NULL,
  app_version  TEXT    NOT NULL,
  user_agent   TEXT    NOT NULL,
  can_reply    BOOLEAN NOT NULL DEFAULT FALSE,
  context      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  at           BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS feedback_at ON feedback (at DESC);
