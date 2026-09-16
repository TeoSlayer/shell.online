-- What the gathering has cost, one row per run.
--
-- The elixir vial in the game shows a total, and a total on its own is a number
-- somebody has to take on trust. This is what it is made of: which machine ran,
-- when, how much it spent, and what it found. Clicking the vial shows these.
--
-- It exists because the gathering is the one part of the game that spends real
-- money and reads real work, and a person who has agreed to that is owed an
-- itemised account of it rather than a running total. Turning the gathering off
-- stops new rows; it does not delete these, because the record of what was
-- already spent on somebody's behalf is theirs to look at.
--
-- Nothing here came from inside a session. The agent that writes these rows
-- runs on the operator's own machine, reads git and the harness's own local
-- files, and reports counts. Sessions are end-to-end encrypted and this service
-- could not read one if it wanted to.
CREATE TABLE IF NOT EXISTS game_collection_runs (
  id           TEXT PRIMARY KEY,
  uid          TEXT   NOT NULL,
  -- The machine that ran it, so "which of my laptops spent that" has an answer.
  device_id    TEXT   NOT NULL DEFAULT '',
  device_name  TEXT   NOT NULL DEFAULT '',
  ran_at       BIGINT NOT NULL,
  -- What the run cost, which is the number the vial is showing.
  tokens       BIGINT NOT NULL DEFAULT 0,
  -- What it found. Counts only; never a branch name, a diff or a message.
  pull_requests BIGINT NOT NULL DEFAULT 0,
  commits      BIGINT NOT NULL DEFAULT 0,
  insertions   BIGINT NOT NULL DEFAULT 0,
  deletions    BIGINT NOT NULL DEFAULT 0,
  -- Empty when the run succeeded. A run that failed is still a run that
  -- happened, and hiding it would make the vial quietly wrong.
  error        TEXT   NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS game_collection_runs_uid_ran_at
  ON game_collection_runs (uid, ran_at DESC);
