-- Owner-only opaque content. Empty rows retain the revocation generation.
CREATE TABLE IF NOT EXISTS session_content (
  session_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  observed_at BIGINT,
  sender_public_key TEXT,
  sealed TEXT,
  published_at BIGINT,
  PRIMARY KEY (session_uid, session_id),
  FOREIGN KEY (session_uid, session_id) REFERENCES sessions(uid, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION invalidate_session_content() RETURNS trigger AS $$
BEGIN
  IF OLD.daily_briefing_enabled IS DISTINCT FROM NEW.daily_briefing_enabled
    OR OLD.share_url IS DISTINCT FROM NEW.share_url
    OR OLD.origin IS DISTINCT FROM NEW.origin
    OR OLD.owner_uid IS DISTINCT FROM NEW.owner_uid
    OR OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    UPDATE session_content SET generation = md5(random()::text || clock_timestamp()::text),
      observed_at = NULL, sender_public_key = NULL, sealed = NULL, published_at = NULL
      WHERE session_uid = NEW.uid AND session_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER session_content_invalidation AFTER UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION invalidate_session_content();

-- A reset changes the account key that can open owner-only content. Lock the
-- session first, matching publishers, so a concurrent upload cannot restore
-- an envelope sealed to the old vault after this transaction commits.
CREATE OR REPLACE FUNCTION invalidate_vault_session_content() RETURNS trigger AS $$
BEGIN
  IF OLD.version IS DISTINCT FROM NEW.version
    OR OLD.public_key IS DISTINCT FROM NEW.public_key THEN
    PERFORM 1 FROM sessions WHERE COALESCE(owner_uid, uid) = NEW.uid
      ORDER BY uid, id FOR UPDATE;
    UPDATE session_content c SET generation = md5(random()::text || clock_timestamp()::text),
      observed_at = NULL, sender_public_key = NULL, sealed = NULL, published_at = NULL
      FROM sessions s WHERE s.uid = c.session_uid AND s.id = c.session_id
        AND COALESCE(s.owner_uid, s.uid) = NEW.uid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER vault_session_content_invalidation AFTER UPDATE ON account_keys
  FOR EACH ROW EXECUTE FUNCTION invalidate_vault_session_content();
