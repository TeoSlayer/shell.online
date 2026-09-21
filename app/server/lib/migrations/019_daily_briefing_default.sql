-- The owner's default for daily-briefing consent on sessions they start.
--
-- It lives on the membership row, keyed by (org_id, uid): the uid of the
-- verified CLI token and the organization that membership actually sits in.
-- Nothing about it ever comes from the caller, and it is not written into
-- credentials.json, which a running daemon from before this column would
-- overwrite on its next save.
--
-- A new session inherits the default at insertion only. A session that has
-- been set already -- opted in or out -- keeps that choice through
-- re-registration, and a default of false is what every existing account
-- reads, which is the consent it gave.
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS daily_briefing_default BOOLEAN NOT NULL DEFAULT FALSE;
