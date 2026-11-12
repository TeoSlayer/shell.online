-- Owner-only session summaries (summary protocol v1). A separate switch, table
-- and generation from session_content: consenting to daily briefings is not
-- consenting to terminal output leaving the host for the attested summarizer.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summaries_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS session_summary (
  session_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  observed_at BIGINT,
  sender_public_key TEXT,
  sealed TEXT,
  published_at BIGINT,
  ticket_issued_at BIGINT,
  PRIMARY KEY (session_uid, session_id),
  FOREIGN KEY (session_uid, session_id) REFERENCES sessions(uid, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION invalidate_session_summary() RETURNS trigger AS $$
BEGIN
  IF OLD.summaries_enabled IS DISTINCT FROM NEW.summaries_enabled
    OR OLD.share_url IS DISTINCT FROM NEW.share_url
    OR OLD.origin IS DISTINCT FROM NEW.origin
    OR OLD.owner_uid IS DISTINCT FROM NEW.owner_uid
    OR OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    UPDATE session_summary SET generation = md5(random()::text || clock_timestamp()::text),
      observed_at = NULL, sender_public_key = NULL, sealed = NULL, published_at = NULL
      WHERE session_uid = NEW.uid AND session_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_summary_invalidation ON sessions;
CREATE TRIGGER session_summary_invalidation AFTER UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION invalidate_session_summary();

-- A vault reset changes the key that can open a summary. Lock the owner's
-- sessions first, in the publishers' order, so a concurrent upload cannot
-- restore an envelope sealed to the old key after this commits.
CREATE OR REPLACE FUNCTION invalidate_vault_session_summary() RETURNS trigger AS $$
BEGIN
  IF OLD.version IS DISTINCT FROM NEW.version
    OR OLD.public_key IS DISTINCT FROM NEW.public_key THEN
    PERFORM 1 FROM sessions WHERE COALESCE(owner_uid, uid) = NEW.uid
      ORDER BY uid, id FOR UPDATE;
    UPDATE session_summary m SET generation = md5(random()::text || clock_timestamp()::text),
      observed_at = NULL, sender_public_key = NULL, sealed = NULL, published_at = NULL
      FROM sessions s WHERE s.uid = m.session_uid AND s.id = m.session_id
        AND COALESCE(s.owner_uid, s.uid) = NEW.uid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vault_session_summary_invalidation ON account_keys;
CREATE TRIGGER vault_session_summary_invalidation AFTER UPDATE ON account_keys
  FOR EACH ROW EXECUTE FUNCTION invalidate_vault_session_summary();
