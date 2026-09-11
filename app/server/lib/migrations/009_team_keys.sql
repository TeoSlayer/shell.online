-- An organization's audit key.
--
-- What people type into a session is recorded for their team. It is sealed in
-- the browser to this public key before it is sent, so the audit log the
-- service keeps is one it cannot read. The private half is held by the team's
-- members, each copy sealed by a teammate to that member's vault key, and
-- never by this service.
--
-- `version` names which key an entry was sealed to, so a key can one day be
-- replaced without making older entries unreadable.
CREATE TABLE IF NOT EXISTS team_keys (
  org_id      TEXT    PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  public_key  TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  BIGINT  NOT NULL
);

-- One member's copy of the private audit key, sealed to their vault. A copy is
-- written once and never replaced by anyone else: a member whose copy no
-- longer opens deletes their own, and a teammate seals a fresh one.
CREATE TABLE IF NOT EXISTS team_key_shares (
  org_id      TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid         TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  sender_uid  TEXT    NOT NULL,
  sealed      TEXT    NOT NULL,
  created_at  BIGINT  NOT NULL,
  PRIMARY KEY (org_id, uid)
);
