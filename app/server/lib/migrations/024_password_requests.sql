-- A teammate asking a session's owner for its password, and the answer.
--
-- The service never holds a password it can open, so it keeps only the ask:
-- the owner's browser seals the password when they accept, and that copy is
-- written to session_key_shares in the same transaction as the answer. One row
-- per person per session run; asking again reopens it. Bound to the session
-- row like its key shares, so a deleted session takes its requests with it.
CREATE TABLE IF NOT EXISTS session_password_requests (
  session_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  requester_uid TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  requested_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolved_by TEXT,
  PRIMARY KEY (session_uid, session_id, requester_uid),
  FOREIGN KEY (session_uid, session_id) REFERENCES sessions(uid, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_password_requests_org
  ON session_password_requests (org_id, session_id);
