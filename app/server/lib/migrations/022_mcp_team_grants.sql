-- Team MCP grant requests: the meeting point between a teammate's account and
-- the session's own machine. The credential column holds only a bearer sealed
-- to the requesting client's temporary public key. It is delivered exactly
-- once (delivered_at), after which the row keeps only what a work list needs.
-- No foreign key to sessions: a row dies with its TTL and the session may be
-- gone the moment after a report, the same bound mcp_flows uses.
CREATE TABLE IF NOT EXISTS mcp_team_grants (
  org_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  requester_uid TEXT NOT NULL,
  recipient_public_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'issued', 'revoked')),
  grant_id TEXT,
  grant_expires_at BIGINT,
  bearer TEXT,
  sealed_to_recipient BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at BIGINT,
  created_at BIGINT NOT NULL,
  /* When a pending request stops being answerable. */
  expires_at BIGINT NOT NULL,
  issued_at BIGINT,
  revoked_at BIGINT,
  CHECK (bearer IS NULL OR sealed_to_recipient = TRUE),
  PRIMARY KEY (org_id, session_id, request_id)
);

CREATE INDEX mcp_team_grants_host ON mcp_team_grants (org_id, session_id);
CREATE INDEX mcp_team_grants_requester ON mcp_team_grants (org_id, requester_uid);
