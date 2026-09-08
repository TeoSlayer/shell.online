-- Stopping a session and removing it from the lists are recorded, so the
-- column has to accept the two kinds that describe them.
--
-- The set of kinds lives in three places that have to agree: this constraint,
-- KINDS in server/routes/audit.ts, and the union in server/lib/types.ts. The
-- first is the one that bites, and it bites only against Postgres: adding a
-- kind to the other two passes every test against the in-memory store and
-- then fails in production with
--
--   new row for relation "audit_events" violates check constraint
--   "audit_events_kind_check"
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_kind_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_kind_check
  CHECK (kind IN ('input', 'interrupt', 'opened', 'handoff', 'stopped', 'deleted'));
