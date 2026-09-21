-- Short-lived MCP flow metadata: what a session's own machine reported about
-- its MCP tool calls. A live feed, not an audit trail.
--
-- expires_at is a service boundary, not a janitor: the moment a row passes it
-- the row is unservable, because every read filters expires_at. The physical
-- delete is opportunistic -- on flow writes and reads, and by the scheduled
-- purge -- so a row may sit in the table a little past its 120-second expiry
-- without ever being shown again.
--
-- binding is the session's provenance hashed at report time (uid, id, org,
-- owner, originating device, started_at, share_url). A read recomputes it
-- from the current session row, so a report is only ever served while the
-- session it came from is still the same session. No foreign key to sessions:
-- the session may be deleted the moment after the report, and the row is
-- already on its way out.
CREATE TABLE IF NOT EXISTS mcp_flows (
  owner_uid TEXT NOT NULL,
  org_id TEXT NOT NULL,
  binding TEXT NOT NULL,
  event_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  tool TEXT NOT NULL,
  at BIGINT NOT NULL,
  outcome TEXT,
  target_session_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (binding, event_id, phase)
);

-- The feed reads one owner's rows; the expiry sweep scans the rest.
CREATE INDEX IF NOT EXISTS mcp_flows_owner ON mcp_flows (org_id, owner_uid);
CREATE INDEX IF NOT EXISTS mcp_flows_expiry ON mcp_flows (expires_at);
