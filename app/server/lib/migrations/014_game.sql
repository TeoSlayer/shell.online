-- The saved game, one row per account.
--
-- Small on purpose. Everything the game can work out again is worked out
-- again: the level from the experience, how fortified the keep is from the
-- level, the purse from the level less what has been spent. What is stored is
-- only what cannot be derived -- who the player chose to be, what they are
-- wearing, what they have bought, what they have spent, and whether they have
-- agreed to the statistics being gathered.
--
-- A row holding both the experience and the level would hold two facts that
-- can disagree, and the day they disagreed somebody would have to decide which
-- one was true. There is no such day here.
--
-- Nothing in this table is private beyond the account it belongs to, and
-- nothing in it comes from a terminal: the service cannot read session output
-- and this does not change that.
CREATE TABLE IF NOT EXISTS game_profiles (
  uid             TEXT PRIMARY KEY,
  character_class TEXT   NOT NULL DEFAULT '',
  skin_id         TEXT   NOT NULL DEFAULT '',
  -- Skins bought, as a JSON array of ids. A handful of short strings; a table
  -- of its own would be three joins to answer "what does this person own".
  owned           TEXT   NOT NULL DEFAULT '[]',
  spent           BIGINT NOT NULL DEFAULT 0,
  gathering       BOOLEAN NOT NULL DEFAULT FALSE,
  -- Counted from what the agent reported, so the elixir vial has something
  -- true to show. Zero until anybody has agreed to the gathering.
  tokens          BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
