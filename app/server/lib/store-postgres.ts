import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Invite, Membership, Organization, Role } from "./orgs";
import {
  DELETED_ACCOUNT_MEMORY_MS,
  DELETED_ACTOR_EMAIL,
  type AccountDeletion,
  type AuditPage,
  type AuditPageQuery,
  type Store,
} from "./store";
import type {
  AccountKey,
  AgentCommand,
  AuditEvent,
  AuthorizationCode,
  CliToken,
  Comment,
  Device,
  Notification,
  SessionKeyShare,
  SessionRecord,
  TeamKey,
  TeamKeyShare,
} from "./types";

/*
 * Every timestamp in this application is a millisecond epoch in a JavaScript
 * number, and BIGINT is how they are stored. node-postgres hands BIGINT back
 * as a string by default, because the range does not fit a double in general.
 * Ours do -- a millisecond epoch stays exact until the year 287396 -- so they
 * are parsed as numbers here rather than at each of the two hundred places a
 * timestamp is read.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/*
 * Where the .sql files live, resolved when one is about to be applied rather
 * than at import. The Worker build imports this module for the store and never
 * migrates -- that is `npm run db:migrate` -- and there `import.meta.url` is
 * undefined, so resolving eagerly would throw before a store could be built at
 * all.
 */
function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

/* An arbitrary constant; only this application takes this advisory lock. */
const MIGRATION_LOCK = 731_099_431;

/** Drops keys whose value is null, so an absent column reads as `undefined`. */
function defined<T extends object>(record: T): T {
  for (const [key, value] of Object.entries(record)) {
    if (value === null) delete (record as Record<string, unknown>)[key];
  }
  return record;
}

type Row = Record<string, unknown>;

/*
 * Column names for the fields a patch may carry. A patch arrives as a partial
 * record, so the update statement has to be built from whichever keys are
 * present; listing the mapping once keeps an unmapped field a missing update
 * rather than a chance for a caller's key to reach SQL.
 */
const TOKEN_COLUMNS: Record<string, string> = {
  id: "id",
  accessHash: "access_hash",
  refreshHash: "refresh_hash",
  uid: "uid",
  email: "email",
  name: "name",
  label: "label",
  machineId: "machine_id",
  accessExpiresAt: "access_expires_at",
  createdAt: "created_at",
  lastSeenAt: "last_seen_at",
  agentSeenAt: "agent_seen_at",
  agentPublicKey: "agent_public_key",
  harnesses: "harnesses",
  revokedAt: "revoked_at",
};

const SESSION_COLUMNS: Record<string, string> = {
  id: "id",
  uid: "uid",
  orgId: "org_id",
  ownerUid: "owner_uid",
  assigneeUid: "assignee_uid",
  shareUrl: "share_url",
  command: "command",
  origin: "origin",
  name: "name",
  readOnly: "read_only",
  encrypted: "encrypted",
  persistent: "persistent",
  host: "host",
  startedAt: "started_at",
  closedAt: "closed_at",
  exitCode: "exit_code",
};

const INVITE_COLUMNS: Record<string, string> = {
  id: "id",
  orgId: "org_id",
  createdBy: "created_by",
  role: "role",
  email: "email",
  createdAt: "created_at",
  expiresAt: "expires_at",
  acceptedAt: "accepted_at",
  acceptedBy: "accepted_by",
  revokedAt: "revoked_at",
};

/**
 * Builds `SET a = $2, b = $3` from a partial record, along with its values.
 *
 * Keys the column map does not know are ignored rather than interpolated,
 * which is what keeps a request body from choosing columns. Returns null when
 * the patch would change nothing, so the caller can skip the statement.
 */
function setClause(
  columns: Record<string, string>,
  patch: Record<string, unknown>,
  firstParameter: number,
): { text: string; values: unknown[] } | null {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (!column) continue;
    parts.push(`${column} = $${firstParameter + values.length}`);
    values.push(value ?? null);
  }
  if (parts.length === 0) return null;
  return { text: parts.join(", "), values };
}

function toToken(row: Row): CliToken {
  return defined({
    id: row.id,
    accessHash: row.access_hash,
    refreshHash: row.refresh_hash,
    uid: row.uid,
    email: row.email,
    name: row.name,
    label: row.label,
    machineId: row.machine_id,
    accessExpiresAt: row.access_expires_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    agentSeenAt: row.agent_seen_at,
    agentPublicKey: row.agent_public_key,
    harnesses: row.harnesses,
    revokedAt: row.revoked_at,
  }) as unknown as CliToken;
}

function toSession(row: Row, shares: SessionKeyShare[]): SessionRecord {
  const assigneeUids = Array.isArray(row.assignee_uids)
    ? (row.assignee_uids as string[])
    : row.assignee_uid
      ? [row.assignee_uid as string]
      : [];
  const session = defined({
    id: row.id,
    uid: row.uid,
    orgId: row.org_id,
    ownerUid: row.owner_uid,
    assigneeUid: row.assignee_uid,
    assigneeUids,
    shareUrl: row.share_url,
    command: row.command,
    origin: row.origin,
    name: row.name,
    readOnly: row.read_only,
    encrypted: row.encrypted,
    persistent: row.persistent,
    host: row.host,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    exitCode: row.exit_code,
  }) as unknown as SessionRecord;
  /*
   * An empty list and an absent one mean different things to the browser: the
   * first says nobody can open this session, the second that it was never
   * sealed. The file store omits the field when it was never set, so this
   * one does too.
   */
  if (shares.length > 0) session.keyShares = shares;
  return session;
}

function toCommand(row: Row): AgentCommand {
  return defined({
    id: row.id,
    uid: row.uid,
    deviceId: row.device_id,
    kind: row.kind,
    command: row.command,
    name: row.name,
    senderPublicKey: row.sender_public_key,
    sealedPassword: row.sealed_password,
    sessionId: row.session_id,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    doneAt: row.done_at,
    error: row.error,
  }) as unknown as AgentCommand;
}

function toMembership(row: Row): Membership {
  return defined({
    orgId: row.org_id,
    uid: row.uid,
    email: row.email,
    name: row.name,
    role: row.role,
    joinedAt: row.joined_at,
    publicKey: row.public_key,
    accountKey: row.account_key,
  }) as unknown as Membership;
}

function toAccountKey(row: Row): AccountKey {
  return {
    uid: row.uid as string,
    publicKey: row.public_key as string,
    encryptedPrivateKey: row.encrypted_private_key as string,
    recoveryWrap: row.recovery_wrap as string,
    version: row.version as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toTeamKey(row: Row): TeamKey {
  return {
    orgId: row.org_id as string,
    publicKey: row.public_key as string,
    version: row.version as number,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
  };
}

function toTeamKeyShare(row: Row): TeamKeyShare {
  return {
    orgId: row.org_id as string,
    uid: row.uid as string,
    version: row.version as number,
    senderUid: row.sender_uid as string,
    sealed: row.sealed as string,
    createdAt: row.created_at as number,
  };
}

function toInvite(row: Row): Invite {
  return defined({
    id: row.id,
    orgId: row.org_id,
    createdBy: row.created_by,
    role: row.role,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    revokedAt: row.revoked_at,
  }) as unknown as Invite;
}

function toAudit(row: Row): AuditEvent {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    sessionId: row.session_id as string,
    at: row.at as number,
    actorUid: row.actor_uid as string,
    actorEmail: row.actor_email as string,
    kind: row.kind as AuditEvent["kind"],
    text: row.text as string,
    ...(row.sealed_by ? { sealedBy: row.sealed_by as string } : {}),
  };
}

function toComment(row: Row): Comment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    sessionId: row.session_id as string,
    authorUid: row.author_uid as string,
    body: row.body as string,
    at: row.at as number,
    mentions: row.mentions as string[],
  };
}

function toNotification(row: Row): Notification {
  return defined({
    id: row.id,
    orgId: row.org_id,
    uid: row.uid,
    kind: row.kind,
    sessionId: row.session_id,
    actorUid: row.actor_uid,
    body: row.body,
    at: row.at,
    readAt: row.read_at,
  }) as unknown as Notification;
}

/**
 * The production store.
 *
 * Reads that belong to one account or organization carry that scope into the
 * WHERE clause rather than filtering afterwards, and writes that have to be
 * atomic -- claiming queued work, marking a code consumed -- are single
 * statements, so two instances of the service can serve the same database.
 */
export class PostgresStore implements Store {
  private constructor(private readonly pool: pg.Pool) {}

  /**
   * Connects, applies any migrations not yet recorded, and hands back a store.
   *
   * Migrating on connect means a container start is the whole deploy: there is
   * no second command to remember, and a rolled-back image finds the schema it
   * expects because migrations only ever add.
   */
  static async connect(
    url: string,
    options: pg.PoolConfig & { migrate?: boolean } = {},
  ): Promise<PostgresStore> {
    /*
     * A small pool on purpose. Postgres counts connections per server, not per
     * client, so the limit is shared by every instance of this service: the
     * smallest Cloud SQL tier allows 25, node-postgres defaults to 10 per
     * process, and a third instance would then be refused a connection rather
     * than made to wait. Requests here are short, so a queue costs milliseconds
     * while exhaustion costs the request.
     *
     * The arithmetic to keep true: instances x max <= max_connections, less a
     * few for administration.
     */
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      /* Released rather than held, so a quiet instance stops occupying slots. */
      idleTimeoutMillis: 30_000,
      /* Better a clear failure than a request that hangs until its timeout. */
      connectionTimeoutMillis: 10_000,
      ...options,
    });
    const store = new PostgresStore(pool);
    /*
     * Migrating on connect suits a long-lived process that starts once. It
     * does not suit a Worker, where every isolate would race the same DDL on
     * its first request, so the caller decides. `npm run db:migrate` is the
     * deliberate path; see migrations.ts.
     */
    if (options.migrate !== false) await store.migrate();
    return store;
  }

  /** Applies pending migrations. Exposed so a deploy step can call it. */
  async migrateNow(): Promise<void> {
    await this.migrate();
  }

  /**
   * Applies every migration file not yet recorded, in filename order.
   *
   * Files are numbered and never edited once applied: the recorded checksum
   * makes an edit an error at boot rather than a schema that differs between
   * two databases that both claim to be at the same version. A change to the
   * schema is therefore always a new file, which is also what makes a rolled
   * back deploy safe -- the old code meets a schema that only gained things.
   */
  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      /*
       * A lock, because two instances starting together would otherwise both
       * see the same work to do. Postgres holds it for this connection until
       * released, and queues the second instance rather than failing it.
       */
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL
         )`,
      );
      /*
       * This one table cannot be brought up to shape by a migration, since it
       * is what records them. So it is repaired in place: a database written
       * by a build from before checksums existed has no such column, and
       * CREATE TABLE IF NOT EXISTS would not add one. Nullable, because a row
       * written back then recorded no checksum and inventing one would be a
       * claim about a file nobody hashed.
       */
      await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");

      const applied = new Map(
        (
          await client.query<{ name: string; checksum: string | null }>(
            "SELECT name, checksum FROM schema_migrations",
          )
        ).rows.map((row) => [row.name, row.checksum]),
      );

      const directory = migrationsDir();
      const files = readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const name of files) {
        const sql = readFileSync(join(directory, name), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        if (applied.has(name)) {
          const previous = applied.get(name);
          /* Recorded before checksums; take the file on trust, once. */
          if (previous === null) {
            await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1", [
              name,
              checksum,
            ]);
            continue;
          }
          if (previous !== checksum) {
            throw new Error(
              `migration ${name} changed after it was applied. Add a new migration ` +
                `instead of editing one, so every database reaches the same schema.`,
            );
          }
          continue;
        }
        /*
         * One transaction per file, with the record written inside it, so a
         * migration that fails halfway leaves nothing behind to reconcile.
         */
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ($1, $2, $3)",
            [name, checksum, Date.now()],
          );
          await client.query("COMMIT");
          console.log(`accounts: applied migration ${name}`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`migration ${name} failed: ${(error as Error).message}`);
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
      client.release();
    }
  }

  private async rows(text: string, values: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(text, values)).rows;
  }

  private async row(text: string, values: unknown[] = []): Promise<Row | null> {
    return (await this.rows(text, values))[0] ?? null;
  }

  /* ---- CLI login ---- */

  async putCode(code: AuthorizationCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_codes (code, uid, email, name, code_challenge, redirect_uri, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (code) DO UPDATE SET
         uid = EXCLUDED.uid, email = EXCLUDED.email, name = EXCLUDED.name,
         code_challenge = EXCLUDED.code_challenge, redirect_uri = EXCLUDED.redirect_uri,
         expires_at = EXCLUDED.expires_at, consumed_at = EXCLUDED.consumed_at`,
      [
        code.code,
        code.uid,
        code.email,
        code.name,
        code.codeChallenge,
        code.redirectUri,
        code.expiresAt,
        code.consumedAt ?? null,
      ],
    );
  }

  /*
   * Marks the code consumed and reports whether it already was, in one
   * statement: the CTE stamps only an unconsumed row, so two clients racing
   * the same code cannot both be told they were first.
   */
  async takeCode(
    code: string,
    now = Date.now(),
  ): Promise<{ entry: AuthorizationCode; alreadyConsumed: boolean } | null> {
    const row = await this.row(
      `WITH claimed AS (
         UPDATE auth_codes SET consumed_at = $2
         WHERE code = $1 AND consumed_at IS NULL
         RETURNING code
       )
       SELECT auth_codes.*, (claimed.code IS NULL) AS already_consumed
       FROM auth_codes LEFT JOIN claimed ON claimed.code = auth_codes.code
       WHERE auth_codes.code = $1`,
      [code, now],
    );
    if (!row) return null;
    const entry = defined({
      code: row.code,
      uid: row.uid,
      email: row.email,
      name: row.name,
      codeChallenge: row.code_challenge,
      redirectUri: row.redirect_uri,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    }) as unknown as AuthorizationCode;
    return { entry, alreadyConsumed: row.already_consumed as boolean };
  }

  async putToken(token: CliToken): Promise<void> {
    await this.pool.query(
      `INSERT INTO cli_tokens
         (id, access_hash, refresh_hash, uid, email, name, label, machine_id,
          access_expires_at, created_at, last_seen_at, agent_seen_at, agent_public_key,
          harnesses, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        token.id,
        token.accessHash,
        token.refreshHash,
        token.uid,
        token.email,
        token.name,
        token.label,
        token.machineId ?? null,
        token.accessExpiresAt,
        token.createdAt,
        token.lastSeenAt,
        token.agentSeenAt ?? null,
        token.agentPublicKey ?? null,
        token.harnesses ?? null,
        token.revokedAt ?? null,
      ],
    );
  }

  async findByAccessHash(hash: string): Promise<CliToken | null> {
    const row = await this.row("SELECT * FROM cli_tokens WHERE access_hash = $1", [hash]);
    return row ? toToken(row) : null;
  }

  async findByRefreshHash(hash: string): Promise<CliToken | null> {
    const row = await this.row("SELECT * FROM cli_tokens WHERE refresh_hash = $1", [hash]);
    return row ? toToken(row) : null;
  }

  async updateToken(refreshHash: string, patch: Partial<CliToken>): Promise<void> {
    const set = setClause(TOKEN_COLUMNS, patch, 2);
    if (!set) return;
    await this.pool.query(`UPDATE cli_tokens SET ${set.text} WHERE refresh_hash = $1`, [
      refreshHash,
      ...set.values,
    ]);
  }

  /*
   * Touching lastSeenAt on every authenticated call would mean a write per
   * request. The resolution only needs to be useful to a person reading a
   * device list, so the WHERE clause settles for a minute -- and does the
   * comparison in the database, which makes it a no-op rather than a read
   * followed by a conditional write.
   */
  async touchToken(id: string, now = Date.now(), resolutionMs = 60_000): Promise<void> {
    await this.pool.query(
      "UPDATE cli_tokens SET last_seen_at = $2 WHERE id = $1 AND $2 - last_seen_at >= $3",
      [id, now, resolutionMs],
    );
  }

  /* ---- Machines ---- */

  /*
   * Scoped by uid so a machine id cannot address another account's device,
   * and to live rows so that unlinking a machine is not undone by the next
   * login on it. Two rows can share a machine id -- two logins racing each
   * other -- so the newest wins, which is the one a device list shows first.
   */
  async deviceForMachine(uid: string, machineId: string): Promise<CliToken | null> {
    const row = await this.row(
      `SELECT * FROM cli_tokens
       WHERE uid = $1 AND machine_id = $2 AND revoked_at IS NULL
       ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT 1`,
      [uid, machineId],
    );
    return row ? toToken(row) : null;
  }

  async machineForDevice(uid: string, deviceId: string): Promise<string | null> {
    /* No revoked_at filter: the point is to find where a dead device lived. */
    const row = await this.row("SELECT machine_id FROM cli_tokens WHERE uid = $1 AND id = $2", [
      uid,
      deviceId,
    ]);
    return (row?.machine_id as string | null) ?? null;
  }

  async setMemberKey(uid: string, publicKey: string): Promise<void> {
    await this.pool.query("UPDATE memberships SET public_key = $2 WHERE uid = $1", [uid, publicKey]);
  }

  /*
   * COALESCE on both published fields, so a poll that carries neither -- an
   * older CLI, or one that has not re-keyed -- records the visit without
   * erasing what the machine said last. An empty harness list is not null, so
   * a machine that reports none does overwrite.
   */
  async markAgentSeen(
    id: string,
    publicKey?: string,
    harnesses?: string[],
    now = Date.now(),
  ): Promise<void> {
    await this.pool.query(
      `UPDATE cli_tokens
       SET agent_seen_at = $2,
           agent_public_key = COALESCE($3, agent_public_key),
           harnesses = COALESCE($4::text[], harnesses)
       WHERE id = $1`,
      [id, now, publicKey ?? null, harnesses ?? null],
    );
  }

  async listDevices(uid: string): Promise<Device[]> {
    const rows = await this.rows(
      `SELECT id, label, created_at, last_seen_at, agent_seen_at, agent_public_key,
              harnesses, revoked_at
       FROM cli_tokens WHERE uid = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id COLLATE "C" DESC`,
      [uid],
    );
    return rows.map(
      (row) =>
        defined({
          id: row.id,
          label: row.label,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          agentSeenAt: row.agent_seen_at,
          agentPublicKey: row.agent_public_key,
          harnesses: row.harnesses,
          revokedAt: row.revoked_at,
        }) as unknown as Device,
    );
  }

  /* Scoped by uid so one account cannot revoke another account's machine. */
  async revokeDevice(uid: string, id: string, now = Date.now()): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE cli_tokens SET revoked_at = $3 WHERE id = $2 AND uid = $1 AND revoked_at IS NULL",
      [uid, id, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /* ---- Sessions ---- */

  /** Returns true when this session had not been seen before. */
  async upsertSession(session: SessionRecord): Promise<boolean> {
    /*
     * `xmax = 0` distinguishes an insert from an update on the conflicting
     * row, which is the answer the caller wants and the only way to get it
     * without a second round trip.
     *
     * A persistent session re-registers on every restart, carrying the owner
     * as assignee. Letting that through would silently undo a handoff, so an
     * assignment already made stands.
     */
    const row = await this.row(
      `INSERT INTO sessions
         (uid, id, org_id, owner_uid, assignee_uid, assignee_uids, share_url, command, origin, name,
          read_only, encrypted, persistent, host, started_at, closed_at, exit_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (uid, id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         owner_uid = EXCLUDED.owner_uid,
         assignee_uid = sessions.assignee_uid,
         assignee_uids = sessions.assignee_uids,
         share_url = EXCLUDED.share_url,
         command = EXCLUDED.command,
         origin = EXCLUDED.origin,
         name = EXCLUDED.name,
         read_only = EXCLUDED.read_only,
         encrypted = EXCLUDED.encrypted,
         persistent = EXCLUDED.persistent,
         host = EXCLUDED.host,
         started_at = EXCLUDED.started_at,
         closed_at = EXCLUDED.closed_at,
         exit_code = EXCLUDED.exit_code
       RETURNING (xmax = 0) AS inserted`,
      [
        session.uid,
        session.id,
        session.orgId ?? null,
        session.ownerUid ?? null,
        session.assigneeUid ?? null,
        session.assigneeUids ?? (session.assigneeUid ? [session.assigneeUid] : []),
        session.shareUrl,
        session.command,
        session.origin ?? null,
        session.name ?? null,
        session.readOnly,
        session.encrypted,
        session.persistent,
        session.host,
        session.startedAt,
        session.closedAt ?? null,
        session.exitCode ?? null,
      ],
    );
    if (session.keyShares?.length) {
      await this.writeShares(session.uid, session.id, session.keyShares);
    }
    return row?.inserted === true;
  }

  private async writeShares(
    sessionUid: string,
    sessionId: string,
    shares: SessionKeyShare[],
  ): Promise<void> {
    for (const share of shares) {
      await this.pool.query(
        `INSERT INTO session_key_shares (session_uid, session_id, uid, sender_public_key, sealed)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_uid, session_id, uid)
         DO UPDATE SET sender_public_key = EXCLUDED.sender_public_key, sealed = EXCLUDED.sealed`,
        [sessionUid, sessionId, share.uid, share.senderPublicKey, share.sealed],
      );
    }
  }

  /** Loads the sealed passwords for a batch of sessions in one query. */
  private async sharesFor(rows: Row[]): Promise<Map<string, SessionKeyShare[]>> {
    const byKey = new Map<string, SessionKeyShare[]>();
    if (rows.length === 0) return byKey;
    const shares = await this.rows(
      `SELECT * FROM session_key_shares
       WHERE (session_uid, session_id) IN (SELECT unnest($1::text[]), unnest($2::text[]))`,
      [rows.map((row) => row.uid), rows.map((row) => row.id)],
    );
    for (const share of shares) {
      const key = `${share.session_uid} ${share.session_id}`;
      const list = byKey.get(key) ?? [];
      list.push({
        uid: share.uid as string,
        senderPublicKey: share.sender_public_key as string,
        sealed: share.sealed as string,
      });
      byKey.set(key, list);
    }
    return byKey;
  }

  private async hydrate(rows: Row[]): Promise<SessionRecord[]> {
    const shares = await this.sharesFor(rows);
    return rows.map((row) => toSession(row, shares.get(`${row.uid} ${row.id}`) ?? []));
  }

  async patchSession(
    uid: string,
    id: string,
    patch: Partial<SessionRecord>,
  ): Promise<SessionRecord | null> {
    const { keyShares, ...columns } = patch;
    const set = setClause(SESSION_COLUMNS, columns, 3);
    if (set) {
      await this.pool.query(`UPDATE sessions SET ${set.text} WHERE uid = $1 AND id = $2`, [
        uid,
        id,
        ...set.values,
      ]);
    }
    if (keyShares?.length) await this.writeShares(uid, id, keyShares);
    const row = await this.row("SELECT * FROM sessions WHERE uid = $1 AND id = $2", [uid, id]);
    return row ? (await this.hydrate([row]))[0] : null;
  }

  /* Scoped by uid at the store boundary so a route cannot leak another account. */
  async listSessions(uid: string): Promise<SessionRecord[]> {
    return this.hydrate(
      await this.rows('SELECT * FROM sessions WHERE uid = $1 ORDER BY started_at DESC, id COLLATE "C" DESC', [uid]),
    );
  }

  /** Every session in an organization, which is what colleagues can see. */
  async listOrgSessions(orgId: string): Promise<SessionRecord[]> {
    return this.hydrate(
      await this.rows('SELECT * FROM sessions WHERE org_id = $1 ORDER BY started_at DESC, id COLLATE "C" DESC', [orgId]),
    );
  }

  async sessionInOrg(orgId: string, id: string): Promise<SessionRecord | null> {
    const row = await this.row("SELECT * FROM sessions WHERE org_id = $1 AND id = $2", [orgId, id]);
    return row ? (await this.hydrate([row]))[0] : null;
  }

  async assignSession(
    orgId: string,
    id: string,
    assigneeUids: string[],
  ): Promise<SessionRecord | null> {
    const row = await this.row(
      `UPDATE sessions
       SET assignee_uid = $3, assignee_uids = $4
       WHERE org_id = $1 AND id = $2
       RETURNING *`,
      [orgId, id, assigneeUids[0] ?? null, assigneeUids],
    );
    return row ? (await this.hydrate([row]))[0] : null;
  }

  /*
   * The row only. Sealed password copies go with it because they are useless
   * without it, and the audit trail deliberately does not: removing a session
   * is an audited act and the record of it outlives the subject.
   */
  async deleteSession(orgId: string, id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM sessions WHERE org_id = $1 AND id = $2", [
      orgId,
      id,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Stores sealed copies of a session password, replacing any for the same uid. */
  async putKeyShares(
    orgId: string,
    sessionId: string,
    shares: SessionKeyShare[],
  ): Promise<boolean> {
    const session = await this.row("SELECT uid FROM sessions WHERE org_id = $1 AND id = $2", [
      orgId,
      sessionId,
    ]);
    if (!session) return false;
    await this.writeShares(session.uid as string, sessionId, shares);
    return true;
  }

  /* ---- Session vault ---- */

  async accountKey(uid: string): Promise<AccountKey | null> {
    const row = await this.row("SELECT * FROM account_keys WHERE uid = $1", [uid]);
    return row ? toAccountKey(row) : null;
  }

  /*
   * Each branch is one conditional statement, so no other request can land
   * between the check and the write.
   */
  async putAccountKey(key: AccountKey, expectedVersion?: number): Promise<boolean> {
    const result = expectedVersion === undefined
      ? await this.pool.query(
          `INSERT INTO account_keys
             (uid, public_key, encrypted_private_key, recovery_wrap, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (uid) DO NOTHING`,
          [key.uid, key.publicKey, key.encryptedPrivateKey, key.recoveryWrap, key.version, key.createdAt, key.updatedAt],
        )
      : await this.pool.query(
          `UPDATE account_keys
           SET public_key = $2, encrypted_private_key = $3, recovery_wrap = $4, version = $5, updated_at = $6
           WHERE uid = $1 AND version = $7`,
          [key.uid, key.publicKey, key.encryptedPrivateKey, key.recoveryWrap, key.version, key.updatedAt, expectedVersion],
        );
    return (result.rowCount ?? 0) > 0;
  }

  /* ---- Account deletion ---- */

  /*
   * One transaction. An account half deleted is worse than either state: it
   * can leave a team with no owner, or a session assigned to nobody.
   */
  async deleteAccount(uid: string, plan: AccountDeletion, now = Date.now()): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (plan.orgId && plan.dissolve) {
        /* Key shares go with their sessions, through the foreign key's cascade. */
        for (const table of ["sessions", "audit_events", "comments", "notifications", "invites", "memberships"]) {
          await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [plan.orgId]);
        }
        await client.query("DELETE FROM organizations WHERE id = $1", [plan.orgId]);
      }
      if (plan.orgId && plan.successorUid) {
        await client.query("UPDATE memberships SET role = 'owner' WHERE org_id = $1 AND uid = $2", [
          plan.orgId,
          plan.successorUid,
        ]);
      }
      for (const statement of [
        "DELETE FROM memberships WHERE uid = $1",
        "DELETE FROM auth_codes WHERE uid = $1",
        "DELETE FROM cli_tokens WHERE uid = $1",
        "DELETE FROM agent_commands WHERE uid = $1",
        "DELETE FROM sessions WHERE uid = $1",
        "DELETE FROM session_key_shares WHERE uid = $1",
        "DELETE FROM account_keys WHERE uid = $1",
        "DELETE FROM comments WHERE author_uid = $1",
        "DELETE FROM notifications WHERE uid = $1 OR actor_uid = $1",
        /* The address an invite was sent to is theirs once they accepted it. */
        "UPDATE invites SET email = NULL WHERE accepted_by = $1",
        /* The right-hand sides read the row as it was, so [1] is the next assignee. */
        `UPDATE sessions SET
           assignee_uids = array_remove(assignee_uids, $1),
           assignee_uid = CASE WHEN assignee_uid = $1
             THEN (array_remove(assignee_uids, $1))[1] ELSE assignee_uid END,
           owner_uid = CASE WHEN owner_uid = $1 THEN uid ELSE owner_uid END
         WHERE $1 = ANY(assignee_uids) OR assignee_uid = $1 OR owner_uid = $1`,
      ]) {
        await client.query(statement, [uid]);
      }
      await client.query("UPDATE audit_events SET actor_email = $2 WHERE actor_uid = $1", [
        uid,
        DELETED_ACTOR_EMAIL,
      ]);
      await client.query(
        `INSERT INTO deleted_accounts (uid, deleted_at) VALUES ($1, $2)
         ON CONFLICT (uid) DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
        [uid, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recentlyDeleted(uid: string, since: number): Promise<boolean> {
    const row = await this.row(
      "SELECT 1 FROM deleted_accounts WHERE uid = $1 AND deleted_at >= $2",
      [uid, since],
    );
    return row !== null;
  }

  /* ---- Agent commands ---- */

  async putCommand(command: AgentCommand): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_commands
         (id, uid, device_id, kind, command, name, sender_public_key, sealed_password,
          session_id, created_at, claimed_at, done_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        command.id,
        command.uid,
        command.deviceId,
        command.kind,
        command.command ?? null,
        command.name ?? null,
        command.senderPublicKey ?? null,
        command.sealedPassword ?? null,
        command.sessionId ?? null,
        command.createdAt,
        command.claimedAt ?? null,
        command.doneAt ?? null,
        command.error ?? null,
      ],
    );
  }

  /*
   * Hands a machine everything queued for it and marks it claimed in the same
   * statement, so two agents on one device cannot both run the same command.
   */
  async claimCommands(deviceId: string, now = Date.now()): Promise<AgentCommand[]> {
    const rows = await this.rows(
      `UPDATE agent_commands SET claimed_at = $2
       WHERE device_id = $1 AND claimed_at IS NULL
       RETURNING *`,
      [deviceId, now],
    );
    return rows.map(toCommand);
  }

  async finishCommand(
    deviceId: string,
    id: string,
    error: string | undefined,
    now = Date.now(),
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_commands SET done_at = $3, error = COALESCE($4, error)
       WHERE id = $2 AND device_id = $1 AND done_at IS NULL`,
      [deviceId, id, now, error ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listCommands(uid: string, limit = 20): Promise<AgentCommand[]> {
    const rows = await this.rows(
      'SELECT * FROM agent_commands WHERE uid = $1 ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $2',
      [uid, limit],
    );
    return rows.map(toCommand);
  }

  /* ---- Organizations ---- */

  async putOrganization(organization: Organization): Promise<void> {
    await this.pool.query(
      `INSERT INTO organizations (id, name, created_at, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [organization.id, organization.name, organization.createdAt, organization.createdBy],
    );
  }

  async organization(orgId: string): Promise<Organization | null> {
    const row = await this.row("SELECT * FROM organizations WHERE id = $1", [orgId]);
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      createdAt: row.created_at as number,
      createdBy: row.created_by as string,
    };
  }

  async renameOrganization(orgId: string, name: string): Promise<boolean> {
    const result = await this.pool.query("UPDATE organizations SET name = $2 WHERE id = $1", [
      orgId,
      name,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Creates the organization and its first membership, or yields to whoever
   * got there first.
   *
   * One transaction, so the organization is not left behind when the
   * membership is not claimed. `ON CONFLICT DO NOTHING` on the uid index is
   * what decides the winner: exactly one caller inserts a row, the rest read
   * back what that caller wrote.
   */
  async claimOwnOrganization(
    organization: Organization,
    membership: Membership,
  ): Promise<Membership> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, name, created_at, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [organization.id, organization.name, organization.createdAt, organization.createdBy],
      );
      const claimed = await client.query(
        `INSERT INTO memberships (org_id, uid, email, name, role, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (uid) DO NOTHING
         RETURNING *`,
        [
          membership.orgId,
          membership.uid,
          membership.email,
          membership.name,
          membership.role,
          membership.joinedAt,
        ],
      );
      if (claimed.rowCount === 0) {
        /* Somebody else claimed this person; undo the organization with it. */
        await client.query("ROLLBACK");
        /*
         * Read on this client, not through the pool. Every racing caller is
         * holding a connection at this point, so asking the pool for a second
         * one deadlocks them all against each other the moment there are more
         * callers than connections.
         */
        const existing = await client.query("SELECT * FROM memberships WHERE uid = $1", [
          membership.uid,
        ]);
        if (existing.rowCount) return toMembership(existing.rows[0]);
        /*
         * Claimed and then removed between the two statements. Vanishingly
         * unlikely, and reporting it beats returning a membership that is not
         * in the database.
         */
        throw new Error("membership was claimed and then withdrawn");
      }
      await client.query("COMMIT");
      return toMembership(claimed.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async putMembership(membership: Membership): Promise<void> {
    /*
     * One statement, conflicting on the uid index rather than the primary key.
     * A person belongs to one organization, so moving them is an update to the
     * row they already have. This used to delete their other memberships and
     * then insert, which is not atomic: two requests racing to place the same
     * person could each pass the delete and then both insert, and the one that
     * lost had already deleted the winner's row.
     */
    await this.pool.query(
      `INSERT INTO memberships (org_id, uid, email, name, role, joined_at, public_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (uid) DO UPDATE SET
         org_id = EXCLUDED.org_id, email = EXCLUDED.email, name = EXCLUDED.name,
         role = EXCLUDED.role, joined_at = EXCLUDED.joined_at,
         public_key = EXCLUDED.public_key`,
      [
        membership.orgId,
        membership.uid,
        membership.email,
        membership.name,
        membership.role,
        membership.joinedAt,
        membership.publicKey ?? null,
      ],
    );
  }

  /** The single organization a person belongs to, or null before signup. */
  async membershipOf(uid: string): Promise<Membership | null> {
    const row = await this.row("SELECT * FROM memberships WHERE uid = $1", [uid]);
    return row ? toMembership(row) : null;
  }

  async members(orgId: string): Promise<Membership[]> {
    /* Each member's vault key rides along, so a password can be sealed to it. */
    const rows = await this.rows(
      `SELECT m.*, a.public_key AS account_key
       FROM memberships m LEFT JOIN account_keys a ON a.uid = m.uid
       WHERE m.org_id = $1 ORDER BY m.joined_at ASC, m.uid COLLATE "C" ASC`,
      [orgId],
    );
    return rows.map(toMembership);
  }

  async removeMember(orgId: string, uid: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM memberships WHERE org_id = $1 AND uid = $2",
      [orgId, uid],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setRole(orgId: string, uid: string, role: Role): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE memberships SET role = $3 WHERE org_id = $1 AND uid = $2",
      [orgId, uid, role],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /* ---- Invites ---- */

  async putInvite(invite: Invite): Promise<void> {
    await this.pool.query(
      `INSERT INTO invites
         (id, org_id, created_by, role, email, created_at, expires_at, accepted_at, accepted_by, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        invite.id,
        invite.orgId,
        invite.createdBy,
        invite.role,
        invite.email ?? null,
        invite.createdAt,
        invite.expiresAt,
        invite.acceptedAt ?? null,
        invite.acceptedBy ?? null,
        invite.revokedAt ?? null,
      ],
    );
  }

  async invite(id: string): Promise<Invite | undefined> {
    const row = await this.row("SELECT * FROM invites WHERE id = $1", [id]);
    return row ? toInvite(row) : undefined;
  }

  async invites(orgId: string): Promise<Invite[]> {
    const rows = await this.rows(
      'SELECT * FROM invites WHERE org_id = $1 ORDER BY created_at DESC, id COLLATE "C" DESC',
      [orgId],
    );
    return rows.map(toInvite);
  }

  async claimInvite(id: string, acceptedBy: string, now = Date.now()): Promise<Invite | undefined> {
    const row = await this.row(
      `UPDATE invites
       SET accepted_at = $3, accepted_by = $2
       WHERE id = $1
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > $3
       RETURNING *`,
      [id, acceptedBy, now],
    );
    return row ? toInvite(row) : undefined;
  }

  async updateInvite(id: string, patch: Partial<Invite>): Promise<void> {
    const set = setClause(INVITE_COLUMNS, patch, 2);
    if (!set) return;
    await this.pool.query(`UPDATE invites SET ${set.text} WHERE id = $1`, [id, ...set.values]);
  }

  /* ---- Team audit key ---- */

  async teamKey(orgId: string): Promise<TeamKey | null> {
    const row = await this.row("SELECT * FROM team_keys WHERE org_id = $1", [orgId]);
    return row ? toTeamKey(row) : null;
  }

  async putTeamKey(key: TeamKey): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO team_keys (org_id, public_key, version, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO NOTHING`,
      [key.orgId, key.publicKey, key.version, key.createdBy, key.createdAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async teamKeyShares(orgId: string): Promise<TeamKeyShare[]> {
    const rows = await this.rows(
      'SELECT * FROM team_key_shares WHERE org_id = $1 ORDER BY created_at ASC, uid COLLATE "C" ASC',
      [orgId],
    );
    return rows.map(toTeamKeyShare);
  }

  /* One statement per copy, each conditional, so an existing copy is never replaced. */
  async putTeamKeyShares(shares: TeamKeyShare[]): Promise<number> {
    let written = 0;
    for (const share of shares) {
      const result = await this.pool.query(
        `INSERT INTO team_key_shares (org_id, uid, version, sender_uid, sealed, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, uid) DO NOTHING`,
        [share.orgId, share.uid, share.version, share.senderUid, share.sealed, share.createdAt],
      );
      written += result.rowCount ?? 0;
    }
    return written;
  }

  async deleteTeamKeyShare(orgId: string, uid: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM team_key_shares WHERE org_id = $1 AND uid = $2", [
      orgId,
      uid,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async plaintextAudit(orgId: string, limit: number): Promise<AuditEvent[]> {
    const rows = await this.rows(
      `SELECT * FROM audit_events
       WHERE org_id = $1 AND kind IN ('input', 'interrupt') AND text NOT LIKE 'a1.%'
       ORDER BY at ASC, id COLLATE "C" ASC
       LIMIT $2`,
      [orgId, limit],
    );
    return rows.map(toAudit);
  }

  async sealAudit(orgId: string, id: string, text: string, sealedBy: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE audit_events SET text = $3, sealed_by = $4
       WHERE org_id = $1 AND id = $2 AND kind IN ('input', 'interrupt') AND text NOT LIKE 'a1.%'`,
      [orgId, id, text, sealedBy],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /* ---- Audit ---- */

  async putAudit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (id, org_id, session_id, at, actor_uid, actor_email, kind, text, sealed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.orgId,
        event.sessionId,
        event.at,
        event.actorUid,
        event.actorEmail,
        event.kind,
        event.text,
        /* Null is first-hand: sealed by the browser that recorded it. */
        event.sealedBy ?? null,
      ],
    );
  }

  async auditFor(orgId: string, sessionId: string): Promise<AuditEvent[]> {
    const rows = await this.rows(
      'SELECT * FROM audit_events WHERE org_id = $1 AND session_id = $2 ORDER BY at ASC, id COLLATE "C" ASC',
      [orgId, sessionId],
    );
    return rows.map(toAudit);
  }

  /*
   * The most recent `limit` events, back in ascending order. The audit page
   * reads a window of history and draws it left to right, so the newest are
   * the ones worth keeping when there are more than fit.
   */
  async auditForOrg(orgId: string, limit = 2000): Promise<AuditEvent[]> {
    const rows = await this.rows(
      `SELECT * FROM (
         SELECT * FROM audit_events WHERE org_id = $1 ORDER BY at DESC, id COLLATE "C" DESC LIMIT $2
       ) recent ORDER BY at ASC, id COLLATE "C" ASC`,
      [orgId, limit],
    );
    return rows.map(toAudit);
  }

  async auditPage(orgId: string, query: AuditPageQuery): Promise<AuditPage> {
    const where = ["org_id = $1"];
    const values: unknown[] = [orgId];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace("?", `$${values.length}`));
    };

    if (query.sessionId) add("session_id = ?", query.sessionId);
    if (query.actorUid) add("actor_uid = ?", query.actorUid);
    if (query.kind) add("kind = ?", query.kind);
    if (query.sinceAt) add("at >= ?", query.sinceAt);
    if (query.query) {
      const literal = query.query.replace(/[\\%_]/g, "\\$&");
      add("text ILIKE ? ESCAPE '\\'", `%${literal}%`);
    }

    const condition = where.join(" AND ");
    const totalRows = await this.rows(
      `SELECT COUNT(*)::int AS total FROM audit_events WHERE ${condition}`,
      values,
    );
    const pageValues = [...values, query.limit, query.offset];
    const rows = await this.rows(
      `SELECT * FROM audit_events
       WHERE ${condition}
       ORDER BY at DESC, id COLLATE "C" DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      pageValues,
    );
    return { events: rows.map(toAudit), total: Number(totalRows[0]?.total ?? 0) };
  }

  /* ---- Comments and notifications ---- */

  async putComment(comment: Comment): Promise<void> {
    await this.pool.query(
      `INSERT INTO comments (id, org_id, session_id, author_uid, body, at, mentions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        comment.id,
        comment.orgId,
        comment.sessionId,
        comment.authorUid,
        comment.body,
        comment.at,
        comment.mentions,
      ],
    );
  }

  async comments(orgId: string, sessionId: string): Promise<Comment[]> {
    const rows = await this.rows(
      'SELECT * FROM comments WHERE org_id = $1 AND session_id = $2 ORDER BY at ASC, id COLLATE "C" ASC',
      [orgId, sessionId],
    );
    return rows.map(toComment);
  }

  async putNotification(notification: Notification): Promise<void> {
    await this.pool.query(
      `INSERT INTO notifications (id, org_id, uid, kind, session_id, actor_uid, body, at, read_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        notification.id,
        notification.orgId,
        notification.uid,
        notification.kind,
        notification.sessionId,
        notification.actorUid,
        notification.body,
        notification.at,
        notification.readAt ?? null,
      ],
    );
  }

  async notificationsFor(uid: string, limit = 100): Promise<Notification[]> {
    const rows = await this.rows(
      'SELECT * FROM notifications WHERE uid = $1 ORDER BY at DESC, id COLLATE "C" DESC LIMIT $2',
      [uid, limit],
    );
    return rows.map(toNotification);
  }

  async markNotificationRead(uid: string, id: string, now = Date.now()): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE notifications SET read_at = $3 WHERE id = $2 AND uid = $1 AND read_at IS NULL",
      [uid, id, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markAllNotificationsRead(uid: string, now = Date.now()): Promise<number> {
    const result = await this.pool.query(
      "UPDATE notifications SET read_at = $2 WHERE uid = $1 AND read_at IS NULL",
      [uid, now],
    );
    return result.rowCount ?? 0;
  }

  /* ---- Housekeeping ---- */

  async purgeExpired(now = Date.now()): Promise<void> {
    await this.pool.query("DELETE FROM auth_codes WHERE expires_at <= $1", [now]);
    /* Finished commands are only kept long enough to be reported back. */
    await this.pool.query("DELETE FROM agent_commands WHERE done_at IS NOT NULL AND done_at < $1", [
      now - 10 * 60_000,
    ]);
    await this.pool.query("DELETE FROM deleted_accounts WHERE deleted_at <= $1", [
      now - DELETED_ACCOUNT_MEMORY_MS,
    ]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
