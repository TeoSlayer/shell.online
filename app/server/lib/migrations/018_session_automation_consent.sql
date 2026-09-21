-- Owner consent for a session's automation.
--
-- Three separate switches, each defaulting to off, because agreeing to one is
-- not agreeing to the others: letting a teammate's agent reach this session
-- over MCP is a different consent from generating a daily briefing, and
-- generating one is a different consent from letting the team read it.
--
-- Registration and re-registration never write these columns; only the
-- owner's explicit update does, and it is scoped to the organization and the
-- row's owner. A NOT NULL default means a row from before this migration
-- reads as "everything off", which is the consent it gave.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mcp_team_access BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS daily_briefing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS daily_briefing_team_access BOOLEAN NOT NULL DEFAULT FALSE;
