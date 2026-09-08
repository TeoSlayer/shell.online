-- Prerelease builds copied committed terminal input into this table. The
-- accounts service no longer accepts those events; remove any legacy content
-- during deployment rather than waiting for scheduled housekeeping.
DELETE FROM audit_events WHERE kind IN ('input', 'interrupt');
