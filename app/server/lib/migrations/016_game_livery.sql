-- What a player's soldiers wear, as distinct from what the player wears.
--
-- The shop sells two things now: a hero skin, which dresses your own figure,
-- and a retinue livery, which washes over the soldiers that stand for your
-- sessions. They are separate columns because they are separate choices, and
-- packing both into the existing `skin_id` would be storing two facts in one
-- field and then parsing them apart for ever after.
--
-- Additive, like every migration here: it never edits a shipped one. An account
-- from before this has no livery, which is the same as not having bought one.
ALTER TABLE game_profiles
  ADD COLUMN IF NOT EXISTS livery_id TEXT NOT NULL DEFAULT '';
