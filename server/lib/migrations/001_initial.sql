-- Timestamps are milliseconds since the epoch, stored as BIGINT.
--
-- The service speaks in JavaScript numbers throughout: every record type
-- carries `Date.now()` values, and the CLI, the browser and the audit export
-- all compare them directly. Converting to timestamptz on the way in and back
-- out again would introduce rounding and timezone questions in exchange for
-- nothing this application asks of the database, so the numbers are stored as
-- they are used. They stay well inside the range JavaScript represents
-- exactly until the year 287396.

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT   NOT NULL,
  created_at  BIGINT NOT NULL,
  created_by  TEXT   NOT NULL
);

-- One row per person per organization. A person belongs to one organization,
-- which the service enforces by looking a membership up by uid alone; the
-- unique index makes that lookup unambiguous rather than trusting the code.
CREATE TABLE IF NOT EXISTS memberships (
  org_id      TEXT   NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid         TEXT   NOT NULL,
  email       TEXT   NOT NULL,
  name        TEXT   NOT NULL,
  role        TEXT   NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at   BIGINT NOT NULL,
  public_key  TEXT,
  PRIMARY KEY (org_id, uid)
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_uid ON memberships (uid);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  org_id       TEXT   NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by   TEXT   NOT NULL,
  role         TEXT   NOT NULL CHECK (role IN ('admin', 'member')),
  email        TEXT,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  accepted_at  BIGINT,
  accepted_by  TEXT,
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS invites_org ON invites (org_id, created_at DESC);

-- Short-lived PKCE authorization codes for `shell login`.
CREATE TABLE IF NOT EXISTS auth_codes (
  code            TEXT PRIMARY KEY,
  uid             TEXT   NOT NULL,
  email           TEXT   NOT NULL,
  name            TEXT   NOT NULL,
  code_challenge  TEXT   NOT NULL,
  redirect_uri    TEXT   NOT NULL,
  expires_at      BIGINT NOT NULL,
  consumed_at     BIGINT
);
CREATE INDEX IF NOT EXISTS auth_codes_expiry ON auth_codes (expires_at);

-- A linked machine. Only hashes of the CLI secrets are kept, so a database
-- copy does not let anyone authenticate as the machine.
CREATE TABLE IF NOT EXISTS cli_tokens (
  id                 TEXT PRIMARY KEY,
  access_hash        TEXT   NOT NULL,
  refresh_hash       TEXT   NOT NULL,
  uid                TEXT   NOT NULL,
  email              TEXT   NOT NULL,
  name               TEXT   NOT NULL,
  label              TEXT   NOT NULL,
  access_expires_at  BIGINT NOT NULL,
  created_at         BIGINT NOT NULL,
  last_seen_at       BIGINT NOT NULL,
  agent_seen_at      BIGINT,
  agent_public_key   TEXT,
  revoked_at         BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS cli_tokens_access  ON cli_tokens (access_hash);
CREATE UNIQUE INDEX IF NOT EXISTS cli_tokens_refresh ON cli_tokens (refresh_hash);
CREATE INDEX IF NOT EXISTS cli_tokens_uid ON cli_tokens (uid, created_at DESC);

-- A session is identified by (uid, id): the id comes from the relay, and
-- scoping it to the account means one account can never address another's.
CREATE TABLE IF NOT EXISTS sessions (
  uid           TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  org_id        TEXT,
  owner_uid     TEXT,
  assignee_uid  TEXT,
  share_url     TEXT    NOT NULL,
  command       TEXT    NOT NULL,
  origin        TEXT,
  name          TEXT,
  read_only     BOOLEAN NOT NULL,
  encrypted     BOOLEAN NOT NULL,
  persistent    BOOLEAN NOT NULL,
  host          TEXT    NOT NULL,
  started_at    BIGINT  NOT NULL,
  closed_at     BIGINT,
  exit_code     INTEGER,
  PRIMARY KEY (uid, id)
);
CREATE INDEX IF NOT EXISTS sessions_org ON sessions (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions (uid, started_at DESC);

-- The session password, sealed once per member. The service relays these and
-- can open none of them, so they are opaque text here.
CREATE TABLE IF NOT EXISTS session_key_shares (
  session_uid        TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  uid                TEXT NOT NULL,
  sender_public_key  TEXT NOT NULL,
  sealed             TEXT NOT NULL,
  PRIMARY KEY (session_uid, session_id, uid),
  FOREIGN KEY (session_uid, session_id) REFERENCES sessions(uid, id) ON DELETE CASCADE
);

-- Work the web app asks a machine to do while it is running `shell agent`.
CREATE TABLE IF NOT EXISTS agent_commands (
  id                 TEXT PRIMARY KEY,
  uid                TEXT   NOT NULL,
  device_id          TEXT   NOT NULL,
  kind               TEXT   NOT NULL CHECK (kind IN ('start', 'kill')),
  command            TEXT,
  name               TEXT,
  sender_public_key  TEXT,
  sealed_password    TEXT,
  session_id         TEXT,
  created_at         BIGINT NOT NULL,
  claimed_at         BIGINT,
  done_at            BIGINT,
  error              TEXT
);
-- Supports the claim query, which is the only hot path: unclaimed work for
-- one device.
CREATE INDEX IF NOT EXISTS agent_commands_queue
  ON agent_commands (device_id) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_commands_uid ON agent_commands (uid, created_at DESC);

-- Every keystroke a person committed to a session: prompts for an agent,
-- commands for a terminal. Plaintext by necessity, since the whole point is
-- that a colleague can read it back.
CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,
  org_id       TEXT   NOT NULL,
  session_id   TEXT   NOT NULL,
  at           BIGINT NOT NULL,
  actor_uid    TEXT   NOT NULL,
  actor_email  TEXT   NOT NULL,
  kind         TEXT   NOT NULL CHECK (kind IN ('input', 'interrupt', 'opened', 'handoff')),
  text         TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_session ON audit_events (org_id, session_id, at);
CREATE INDEX IF NOT EXISTS audit_org     ON audit_events (org_id, at);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT   NOT NULL,
  session_id  TEXT   NOT NULL,
  author_uid  TEXT   NOT NULL,
  body        TEXT   NOT NULL,
  at          BIGINT NOT NULL,
  mentions    TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS comments_session ON comments (org_id, session_id, at);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  org_id      TEXT   NOT NULL,
  uid         TEXT   NOT NULL,
  kind        TEXT   NOT NULL CHECK (kind IN ('mention', 'assigned', 'shared')),
  session_id  TEXT   NOT NULL,
  actor_uid   TEXT   NOT NULL,
  body        TEXT   NOT NULL,
  at          BIGINT NOT NULL,
  read_at     BIGINT
);
CREATE INDEX IF NOT EXISTS notifications_inbox ON notifications (uid, at DESC);
