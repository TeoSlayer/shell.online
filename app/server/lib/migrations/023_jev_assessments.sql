-- External-analysis (Jev): the owner's separate consent, the short-lived
-- advisory assessments, and the shared request/character budget.
--
-- Consent has no default row: absent means off. updated_at is a strictly
-- increasing version, not a clock reading alone, because an assessment names
-- the exact version it started under and a revoke must outrank every writer
-- that began before it.
--
-- jev_assessments holds model output and the minimized observed facts it was
-- given, never terminal text. expires_at is a service boundary like mcp_flows:
-- every read filters it, and the physical delete is opportunistic. No foreign
-- key to sessions: the session may be deleted the moment after the write, and
-- the read rechecks ownership and the session's started_at (its incarnation)
-- from the live session row, so a deleted-then-recreated id, a reopen or a
-- handoff cannot serve the old run's snapshot. Lifecycle changes also delete
-- the rows in the same step; this binding is the backstop.
CREATE TABLE IF NOT EXISTS external_analysis_consents (
  org_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (org_id, owner_uid)
);

CREATE TABLE IF NOT EXISTS jev_assessments (
  org_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  generation BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  model JSONB NOT NULL,
  observed JSONB NOT NULL,
  disclaimer TEXT NOT NULL,
  PRIMARY KEY (org_id, owner_uid, session_id)
);

-- The list reads one owner's unexpired rows; the purge scans the rest.
CREATE INDEX IF NOT EXISTS jev_assessments_expiry ON jev_assessments (org_id, owner_uid, expires_at);

-- One row per spent assessment. The window is a sliding one: consumption
-- prunes rows older than the window under an advisory lock, so the counts are
-- enforced across workers.
CREATE TABLE IF NOT EXISTS jev_budget (
  org_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  at BIGINT NOT NULL,
  chars INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jev_budget_owner ON jev_budget (org_id, owner_uid, at);
