import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CONTENT_INTERVAL_MS, contentPublisher, type SessionContent, type SessionContentPolicy, type ContentWriteResult } from "./session-content";
import {
  MCP_FLOW_GLOBAL_LIMIT,
  MCP_FLOW_LIMIT,
  mcpFlowAllowedBindings,
  mcpFlowBinding,
  mcpFlowExpiry,
  type McpFlow,
  type McpFlowEvent,
} from "./mcp-flows";
import { JEV_BUDGET, JEV_MAX_SNAPSHOTS } from "./jev/limits";
import type { AssessmentSnapshot, JevConsent } from "./jev/integration";
import {
  MCP_TEAM_GLOBAL_LIMIT,
  MCP_TEAM_ISSUED_LIMIT,
  MCP_TEAM_PENDING_LIMIT,
  MCP_TEAM_REQUEST_TTL,
  MCP_TEAM_REVOKED_LIMIT,
  sealTeamBearer,
  teamPublisher,
  type McpTeamGrantReport,
  type McpTeamHostRequest,
  type McpTeamRequest,
  type McpTeamReportResult,
  type McpTeamRequestResult,
} from "./mcp-team";
import { newId, type Invite, type Membership, type Organization, type Role } from "./orgs";
import {
  ACCOUNT_ACTIVITY_MEMORY_MS,
  DAY_MS,
  DELETED_ACCOUNT_MEMORY_MS,
  DELETED_ACTOR_EMAIL,
  type AccountDeletion,
  type AuditPage,
  type AuditPageQuery,
  type Store,
} from "./store";
import type {
  AccountActivity,
  AppEvent,
  AppEventCount,
  AccountKey,
  AgentCommand,
  AuditEvent,
  AuthorizationCode,
  CliToken,
  Comment,
  Device,
  Feedback,
  GameCollectionRun,
  GameProfile,
  Notification,
  SessionAutomationConsent,
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

/*
 * The one lock that spans every owner's flow rows. The global cap is the only
 * bound a per-owner lock cannot enforce: two owners reporting at once each
 * see the other's rows as not-yet-committed and each trims too little. So
 * every flow transaction takes this lock first, which is what makes the count
 * and the trim it triggers see the table as one writer would leave it.
 */
const MCP_FLOWS_GLOBAL_LOCK = 731_099_432;
const MCP_TEAM_GLOBAL_LOCK = 731_099_433;

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
    mcpTeamAccess: row.mcp_team_access,
    dailyBriefingEnabled: row.daily_briefing_enabled,
    dailyBriefingTeamAccess: row.daily_briefing_team_access,
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

function toMcpFlow(row: Row): McpFlow {
  return {
    id: row.event_id as string,
    tool: row.tool as McpFlow["tool"],
    phase: row.phase as McpFlow["phase"],
    at: row.at as number,
    ...(row.outcome ? { outcome: row.outcome as McpFlow["outcome"] } : {}),
    targetSessionId: row.target_session_id as string,
  };
}

function toJevConsent(row: Row): JevConsent {
  return {
    externalAnalysis: row.enabled as boolean,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by as string,
  };
}

function toJevAssessment(row: Row): AssessmentSnapshot {
  return {
    sessionId: row.session_id as string,
    generation: Number(row.generation ?? 0),
    observedAt: Number(row.observed_at),
    expiresAt: Number(row.expires_at),
    model: row.model as AssessmentSnapshot["model"],
    observed: (row.observed ?? {}) as Record<string, unknown>,
    disclaimer: row.disclaimer as string,
  };
}

function toMcpTeamRequest(row: Row): McpTeamRequest {
  return {
    requestId: row.request_id as string,
    orgId: row.org_id as string,
    sessionId: row.session_id as string,
    requesterUid: row.requester_uid as string,
    status: row.status as McpTeamRequest["status"],
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    recipientPublicKey: row.recipient_public_key as string,
    sealedToRecipient: row.sealed_to_recipient === true,
    ...(row.grant_id ? { grantId: row.grant_id as string } : {}),
    ...(row.grant_expires_at !== null ? { grantExpiresAt: Number(row.grant_expires_at) } : {}),
    ...(row.bearer ? { bearer: row.bearer as string } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: Number(row.delivered_at) } : {}),
    ...(row.issued_at !== null ? { issuedAt: Number(row.issued_at) } : {}),
    ...(row.revoked_at !== null ? { revokedAt: Number(row.revoked_at) } : {}),
  };
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
    lastSeenAt: row.last_seen_at ?? undefined,
    publicKey: row.public_key,
    accountKey: row.account_key,
    /* NOT NULL DEFAULT FALSE, so a row that never set it reads as off. */
    dailyBriefingDefault: row.daily_briefing_default === true,
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

function toFeedback(row: Row): Feedback {
  return {
    id: row.id as string,
    uid: row.uid as string,
    email: row.email as string,
    ...(row.org_id ? { orgId: row.org_id as string } : {}),
    kind: row.kind as Feedback["kind"],
    body: row.body as string,
    surface: row.surface as string,
    route: row.route as string,
    appVersion: row.app_version as string,
    userAgent: row.user_agent as string,
    canReply: row.can_reply as boolean,
    context: (row.context ?? {}) as Record<string, string>,
    at: row.at as number,
  };
}

/**
 * The production store.
 *
 * Reads that belong to one account or organization carry that scope into the
 * WHERE clause rather than filtering afterwards, and writes that have to be
 * atomic -- claiming queued work, marking a code consumed -- are single
 * statements, so two instances of the service can serve the same database.
 */
/**
 * The skins an account owns, from the JSON text they are stored as.
 *
 * A value that will not parse is read as owning nothing rather than throwing.
 * A save that cannot be read should cost somebody their hats, not their
 * ability to open the game at all.
 */
function readOwned(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

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
  private async withContentSession<T>(orgId: string, sessionId: string, ownerUid: string, deviceId: string, missing: T, action: (client: pg.PoolClient, session: SessionRecord, state: Row) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<Row>("SELECT * FROM sessions WHERE org_id = $1 AND id = $2 AND COALESCE(owner_uid, uid) = $3 FOR UPDATE", [orgId, sessionId, ownerUid]);
      const session = found.rows[0] ? toSession(found.rows[0], []) : null;
      if (!session || !contentPublisher(session, orgId, ownerUid, deviceId)) {
        await client.query("ROLLBACK");
        return missing;
      }
      await client.query("INSERT INTO session_content (session_uid, session_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [session.uid, sessionId]);
      const state = await client.query<Row>("SELECT * FROM session_content WHERE session_uid = $1 AND session_id = $2", [session.uid, sessionId]);
      const result = await action(client, session, state.rows[0]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve original error. */ }
      throw error;
    } finally { client.release(); }
  }

  async sessionContentPolicy(orgId: string, sessionId: string, ownerUid: string, deviceId: string): Promise<SessionContentPolicy | null> {
    return this.withContentSession<SessionContentPolicy | null>(orgId, sessionId, ownerUid, deviceId, null, async (_client, session, state) => ({
      enabled: session.dailyBriefingEnabled === true, ownerUid, generation: state.generation as string,
      nextPublishAt: state.published_at === null ? 0 : Number(state.published_at) + CONTENT_INTERVAL_MS,
    }));
  }

  async putSessionContent(orgId: string, sessionId: string, ownerUid: string, deviceId: string, content: SessionContent, now = Date.now()): Promise<ContentWriteResult> {
    return this.withContentSession<ContentWriteResult>(orgId, sessionId, ownerUid, deviceId, "missing", async (client, session, state) => {
      if (!session.dailyBriefingEnabled) return "disabled";
      if (content.generation !== state.generation) return "stale";
      if (state.observed_at === content.observedAt && state.sender_public_key === content.senderPublicKey && state.sealed === content.sealed) return "stored";
      if (state.published_at !== null && now < Number(state.published_at) + CONTENT_INTERVAL_MS) return "limited";
      await client.query("UPDATE session_content SET observed_at=$3, sender_public_key=$4, sealed=$5, published_at=$6 WHERE session_uid=$1 AND session_id=$2", [session.uid, sessionId, content.observedAt, content.senderPublicKey, content.sealed, now]);
      return "stored";
    });
  }

  async getSessionContent(orgId: string, sessionId: string, ownerUid: string): Promise<SessionContent | null> {
    const row = await this.row(`SELECT c.* FROM session_content c JOIN sessions s ON s.uid=c.session_uid AND s.id=c.session_id
      WHERE s.org_id=$1 AND s.id=$2 AND COALESCE(s.owner_uid,s.uid)=$3 AND s.daily_briefing_enabled=true AND c.sealed IS NOT NULL`, [orgId, sessionId, ownerUid]);
    return row ? { generation: row.generation as string, observedAt: row.observed_at as number, senderPublicKey: row.sender_public_key as string, sealed: row.sealed as string } : null;
  }

  /* ---- MCP flow feed ---- */

  /**
   * The flow table's locks, in the one order every flow transaction uses:
   * global, then owner, then (for a write) the session row.
   *
   * The global lock is what makes the global cap honest -- see
   * MCP_FLOWS_GLOBAL_LOCK -- and the owner lock keeps the per-owner cap
   * honest the same way. Taking the global lock first also means the ordering
   * cannot deadlock against the session lifecycle: a flow transaction waits
   * on a session row only while holding locks that no non-flow transaction
   * ever asks for, so a lifecycle transaction holding that row can never be
   * waiting on a flow transaction in turn.
   */
  private async lockFlows(client: pg.PoolClient, orgId: string, ownerUid: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MCP_FLOWS_GLOBAL_LOCK]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mcp_flows:${orgId}:${ownerUid}`]);
  }

  /**
   * Keeps the table at its bounds, in the caller's transaction, which must
   * already hold the flow table locks (global, then owner): one owner's share
   * at most MCP_FLOW_LIMIT rows, the table at most MCP_FLOW_GLOBAL_LIMIT
   * rows, and an opportunistic sweep of whatever has expired.
   *
   * Expiry is a service boundary, not a janitor: the instant a row passes
   * expires_at it is unservable, because every read filters expires_at. The
   * physical delete happens on the operations around it (writes, reads, the
   * scheduled purge), so a row can outlive its TTL in the table by a little
   * without ever being shown. The sweep is capped so a quiet table costs one
   * index scan and a busy one sheds a little on each call rather than one big
   * delete.
   */
  private async trimMcpFlows(client: pg.PoolClient, orgId: string, ownerUid: string, now: number): Promise<void> {
    await client.query(
      `WITH kept AS (
         SELECT ctid FROM mcp_flows WHERE org_id = $1 AND owner_uid = $2
         ORDER BY at DESC, event_id COLLATE "C" DESC LIMIT $3
       )
       DELETE FROM mcp_flows
       WHERE org_id = $1 AND owner_uid = $2 AND ctid NOT IN (SELECT ctid FROM kept)`,
      [orgId, ownerUid, MCP_FLOW_LIMIT],
    );
    /*
     * The total backstop: the per-owner caps already bound a healthy table,
     * so this only runs when a burst of many owners has pushed it past the
     * limit, and it sheds the oldest rows back to it.
     */
    const total = await client.query<{ total: number }>("SELECT count(*)::int AS total FROM mcp_flows");
    if ((total.rows[0]?.total ?? 0) > MCP_FLOW_GLOBAL_LIMIT) {
      await client.query(
        `WITH ranked AS (
           SELECT ctid, row_number() OVER (ORDER BY at DESC, event_id COLLATE "C" DESC) AS rank
           FROM mcp_flows
         )
         DELETE FROM mcp_flows WHERE ctid IN (SELECT ctid FROM ranked WHERE rank > $1)`,
        [MCP_FLOW_GLOBAL_LIMIT],
      );
    }
    await client.query(
      `WITH expired AS (SELECT ctid FROM mcp_flows WHERE expires_at <= $1 LIMIT 1000)
       DELETE FROM mcp_flows WHERE ctid IN (SELECT ctid FROM expired)`,
      [now],
    );
  }

  async putMcpFlows(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    deviceId: string,
    events: McpFlowEvent[],
    now = Date.now(),
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /*
       * The table locks first, so the caps below see every other flow report
       * as committed or pending, never half-applied.
       */
      await this.lockFlows(client, orgId, ownerUid);
      /*
       * The session row is the bound, locked so a report cannot race the
       * session closing, being deleted, or changing provenance: whichever
       * happens first wins, and a report that loses the race writes nothing
       * rather than a row that outlives the session it describes.
       */
      const found = await client.query<Row>(
        `SELECT * FROM sessions
         WHERE org_id = $1 AND id = $2 AND COALESCE(owner_uid, uid) = $3 AND closed_at IS NULL
         FOR UPDATE`,
        [orgId, sessionId, ownerUid],
      );
      const row = found.rows[0];
      if (!row || !contentPublisher(toSession(row, []), orgId, ownerUid, deviceId)) {
        await client.query("ROLLBACK");
        return false;
      }
      const binding = mcpFlowBinding(toSession(row, []));
      for (const event of events) {
        /*
         * A conflict is a retry: the first write's row stands, metadata and
         * expiry included. DO NOTHING is the whole dedup, which is what keeps
         * a retry from extending the row's lifetime.
         */
        await client.query(
          `INSERT INTO mcp_flows
             (owner_uid, org_id, binding, event_id, phase, tool, at, outcome, target_session_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (binding, event_id, phase) DO NOTHING`,
          [
            ownerUid,
            orgId,
            binding,
            event.id,
            event.phase,
            event.tool,
            event.at,
            event.outcome ?? null,
            sessionId,
            mcpFlowExpiry(event.at, now),
          ],
        );
      }
      await this.trimMcpFlows(client, orgId, ownerUid, now);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listMcpFlows(orgId: string, ownerUid: string, activeDevices: Set<string>, now = Date.now()): Promise<McpFlow[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /*
       * The same table locks as the writers: this transaction purges and
       * trims as well as reads, and a writer mid-flight must not be trimmed
       * out from under its own caps.
       */
      await this.lockFlows(client, orgId, ownerUid);
      const sessions = await client.query<Row>(
        `SELECT * FROM sessions WHERE org_id = $1 AND COALESCE(owner_uid, uid) = $2 AND closed_at IS NULL`,
        [orgId, ownerUid],
      );
      const allowed = mcpFlowAllowedBindings(
        sessions.rows.map((row) => toSession(row, [])),
        orgId,
        ownerUid,
        activeDevices,
      );
      /*
       * Purge lost access so restoring it cannot resurrect these rows. The
       * purge is housekeeping; the read below rechecks the binding itself, so
       * a row that lands between the two cannot be served either.
       */
      if (allowed.size > 0) {
        await client.query(
          `DELETE FROM mcp_flows WHERE org_id = $1 AND owner_uid = $2 AND binding <> ALL($3)`,
          [orgId, ownerUid, [...allowed]],
        );
      } else {
        await client.query(`DELETE FROM mcp_flows WHERE org_id = $1 AND owner_uid = $2`, [orgId, ownerUid]);
      }
      await this.trimMcpFlows(client, orgId, ownerUid, now);
      /*
       * A session can only serve flows while its provenance is one of the
       * allowed bindings, so the read intersects them: an empty set matches
       * nothing, and a rebind that changes any provenance field changes the
       * binding, which is what keeps a stale row from passing for a new
       * session that happens to reuse the id.
       */
      const result = await client.query<Row>(
        `SELECT * FROM (
           SELECT * FROM mcp_flows
           WHERE org_id = $1 AND owner_uid = $2 AND expires_at > $3 AND binding = ANY($4)
           ORDER BY at DESC, event_id COLLATE "C" DESC LIMIT $5
         ) recent ORDER BY at ASC, event_id COLLATE "C" ASC`,
        [orgId, ownerUid, now, [...allowed], MCP_FLOW_LIMIT],
      );
      await client.query("COMMIT");
      return result.rows.map(toMcpFlow);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /* ---- External analysis (Jev) ---- */

  async jevConsent(orgId: string, ownerUid: string): Promise<JevConsent | null> {
    const result = await this.pool.query<Row>(
      `SELECT * FROM external_analysis_consents WHERE org_id = $1 AND owner_uid = $2`,
      [orgId, ownerUid],
    );
    return result.rows[0] ? toJevConsent(result.rows[0]) : null;
  }

  async putJevConsent(
    orgId: string,
    ownerUid: string,
    enabled: boolean,
    updatedBy: string,
    expectedUpdatedAt: number | null,
    now = Date.now(),
  ): Promise<JevConsent | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /*
       * One per-owner advisory lock, shared with the assessment write and the
       * revocation purge. The row lock below cannot serialize two *initial*
       * writers, because absence has no row to lock: without this, both would
       * read absence and one would raise a uniqueness error instead of the
       * documented null conflict.
       */
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`jev_consent:${orgId}:${ownerUid}`]);
      /* The row lock makes the compare-and-swap exact: two writers serialize
         here, and only the one holding the stored version can move it. */
      const found = await client.query<Row>(
        `SELECT * FROM external_analysis_consents WHERE org_id = $1 AND owner_uid = $2 FOR UPDATE`,
        [orgId, ownerUid],
      );
      const existing = found.rows[0];
      if ((existing ? Number(existing.updated_at) : null) !== expectedUpdatedAt) {
        await client.query("ROLLBACK");
        return null;
      }
      /* Strictly newer than whatever was stored, even within a millisecond. */
      const updatedAt = Math.max(now, (existing ? Number(existing.updated_at) : 0) + 1);
      const saved = existing
        ? await client.query<Row>(
            `UPDATE external_analysis_consents SET enabled = $3, updated_at = $4, updated_by = $5
             WHERE org_id = $1 AND owner_uid = $2 RETURNING *`,
            [orgId, ownerUid, enabled, updatedAt, updatedBy],
          )
        : await client.query<Row>(
            `INSERT INTO external_analysis_consents (org_id, owner_uid, enabled, updated_at, updated_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [orgId, ownerUid, enabled, updatedAt, updatedBy],
          );
      /* Revocation deletes every cached result in the same transaction, so
         no reader depends on remembering to purge afterwards. */
      if (!enabled) {
        await client.query(`DELETE FROM jev_assessments WHERE org_id = $1 AND owner_uid = $2`, [
          orgId,
          ownerUid,
        ]);
      }
      await client.query("COMMIT");
      return toJevConsent(saved.rows[0]);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeJevBudget(orgId: string, ownerUid: string, chars: number, now = Date.now()): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /*
       * One advisory lock per owner serializes every worker's spend, so the
       * window is enforced across service instances and not per process.
       */
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`jev_budget:${orgId}:${ownerUid}`]);
      await client.query(`DELETE FROM jev_budget WHERE org_id = $1 AND owner_uid = $2 AND at <= $3`, [
        orgId,
        ownerUid,
        now - JEV_BUDGET.windowMs,
      ]);
      const spent = await client.query<Row>(
        `SELECT COUNT(*) AS hits, COALESCE(SUM(chars), 0) AS chars FROM jev_budget WHERE org_id = $1 AND owner_uid = $2`,
        [orgId, ownerUid],
      );
      const hits = Number(spent.rows[0]?.hits ?? 0);
      const charsSpent = Number(spent.rows[0]?.chars ?? 0);
      const cost = Math.max(0, Math.floor(chars));
      if (hits >= JEV_BUDGET.maxRequests || charsSpent + cost > JEV_BUDGET.maxInputChars) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(`INSERT INTO jev_budget (org_id, owner_uid, at, chars) VALUES ($1, $2, $3, $4)`, [
        orgId,
        ownerUid,
        now,
        cost,
      ]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async putJevAssessment(
    orgId: string,
    ownerUid: string,
    snapshot: AssessmentSnapshot,
    expectedUpdatedAt: number,
  ): Promise<boolean> {
    /*
     * One predicate, one statement: the SELECT yields a row only while the
     * consent is enabled at exactly the version the model call started under
     * and the session is still open and owned. The conflict path replaces the
     * previous snapshot for the same session, so the table stays one row per
     * owner and session, and a revoke that lands mid-call leaves nothing.
     */
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /*
       * The same per-owner lock the consent CAS and the revocation purge take.
       * Under READ COMMITTED a bare INSERT..SELECT could retain a predicate
       * snapshot taken before a revoke, then commit after the purge and leave
       * a row behind. Serialized, the two orders are the only ones: either the
       * write lands first and the revoke purges it in the same step, or the
       * revoke lands first and the locked predicate below sees it and refuses.
       */
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`jev_consent:${orgId}:${ownerUid}`]);
      const consent = await client.query<Row>(
        `SELECT * FROM external_analysis_consents WHERE org_id = $1 AND owner_uid = $2 FOR UPDATE`,
        [orgId, ownerUid],
      );
      const consentRow = consent.rows[0];
      if (!consentRow || !consentRow.enabled || Number(consentRow.updated_at) !== expectedUpdatedAt) {
        await client.query("ROLLBACK");
        return false;
      }
      /*
       * The session row is locked too: a close or ownership change that lands
       * first makes the predicate false, and one that lands second waits and
       * then leaves the row unservable (the list rechecks this same binding).
       */
      const session = await client.query<Row>(
        `SELECT * FROM sessions
         WHERE org_id = $1 AND id = $2 AND COALESCE(owner_uid, uid) = $3 AND closed_at IS NULL
         FOR UPDATE`,
        [orgId, snapshot.sessionId, ownerUid],
      );
      const sessionRow = session.rows[0];
      if (!sessionRow) {
        await client.query("ROLLBACK");
        return false;
      }
      const inserted = await client.query<Row>(
        `INSERT INTO jev_assessments
           (org_id, owner_uid, session_id, started_at, generation, observed_at, expires_at, model, observed, disclaimer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
         ON CONFLICT (org_id, owner_uid, session_id) DO UPDATE
           SET started_at = EXCLUDED.started_at,
               generation = EXCLUDED.generation,
               observed_at = EXCLUDED.observed_at,
               expires_at = EXCLUDED.expires_at,
               model = EXCLUDED.model,
               observed = EXCLUDED.observed,
               disclaimer = EXCLUDED.disclaimer
         RETURNING session_id`,
        [
          orgId,
          ownerUid,
          snapshot.sessionId,
          Number(sessionRow.started_at),
          snapshot.generation,
          snapshot.observedAt,
          snapshot.expiresAt,
          JSON.stringify(snapshot.model),
          JSON.stringify(snapshot.observed),
          snapshot.disclaimer,
        ],
      );
      await client.query("COMMIT");
      return inserted.rows.length > 0;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listJevAssessments(orgId: string, ownerUid: string, now = Date.now()): Promise<AssessmentSnapshot[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /* Purge what lost its session or its life, so a reactivated session id
         cannot resurrect an old snapshot. */
      await client.query(
        `DELETE FROM jev_assessments
         WHERE org_id = $1 AND owner_uid = $2
           AND (expires_at <= $3
             OR NOT EXISTS (
               SELECT 1 FROM sessions s
               WHERE s.org_id = $1 AND s.id = jev_assessments.session_id
                 AND COALESCE(s.owner_uid, s.uid) = $2
                 AND s.started_at = jev_assessments.started_at
                 AND s.closed_at IS NULL
             ))`,
        [orgId, ownerUid, now],
      );
      const rows = await client.query<Row>(
        `SELECT * FROM jev_assessments
         WHERE org_id = $1 AND owner_uid = $2 AND expires_at > $3
         ORDER BY observed_at DESC, session_id COLLATE "C" DESC
         LIMIT $4`,
        [orgId, ownerUid, now, JEV_MAX_SNAPSHOTS],
      );
      await client.query("COMMIT");
      return rows.rows.map(toJevAssessment);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async dropJevAssessments(orgId: string, ownerUid: string, sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const result = await this.pool.query(
      `DELETE FROM jev_assessments WHERE org_id = $1 AND owner_uid = $2 AND session_id = ANY($3)`,
      [orgId, ownerUid, sessionIds],
    );
    return result.rowCount ?? 0;
  }

  async clearJevAssessments(orgId: string, ownerUid: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM jev_assessments WHERE org_id = $1 AND owner_uid = $2`,
      [orgId, ownerUid],
    );
    return result.rowCount ?? 0;
  }

  /* ---- Team MCP grants ---- */

  /**
   * The team table's locks, in the one order every team transaction uses:
   * global, then session. The global lock makes the global cap honest; the
   * session lock keeps the per-session caps honest. Same deadlock argument
   * as the flow table: a team transaction waits on a session row only while
   * holding locks no other transaction asks for.
   */
  private async lockTeamSession(client: pg.PoolClient, orgId: string, sessionId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MCP_TEAM_GLOBAL_LOCK]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mcp_team:${orgId}:${sessionId}`]);
  }

  /**
   * Keeps the table at its bounds, in the caller's transaction, which must
   * already hold the team table locks. A row is swept once it has done
   * everything it can (pending past its deadline, revoked past the grace,
   * issued past its grant's expiry); over-cap rows are revoked, not deleted.
   */
  private async trimMcpTeamRows(client: pg.PoolClient, now: number): Promise<void> {
    await client.query(
      `DELETE FROM mcp_team_grants
       WHERE (status = 'pending' AND expires_at <= $1::bigint - 3600000)
          OR (status = 'revoked' AND COALESCE(revoked_at, created_at) <= $1::bigint - 3600000)
          OR (status = 'issued' AND COALESCE(grant_expires_at, created_at) <= $1::bigint - 3600000)`,
      [now],
    );
    await client.query(
      `WITH ranked AS (
         SELECT ctid, org_id, session_id, status,
                row_number() OVER (
                  PARTITION BY org_id, session_id, status
                  ORDER BY created_at DESC, request_id COLLATE "C" DESC
                ) AS rank
         FROM mcp_team_grants
       )
       UPDATE mcp_team_grants r
       SET status = 'revoked', revoked_at = $1
       FROM ranked
       WHERE r.ctid = ranked.ctid AND r.status <> 'revoked'
         AND (
           (ranked.status = 'pending' AND ranked.rank > $2)
           OR (ranked.status = 'issued' AND ranked.rank > $3)
           OR (ranked.status = 'revoked' AND ranked.rank > $4)
         )`,
      [now, MCP_TEAM_PENDING_LIMIT, MCP_TEAM_ISSUED_LIMIT, MCP_TEAM_REVOKED_LIMIT],
    );
    const total = await client.query<{ total: number }>("SELECT count(*)::int AS total FROM mcp_team_grants");
    if ((total.rows[0]?.total ?? 0) > MCP_TEAM_GLOBAL_LIMIT) {
      await client.query(
        `WITH ranked AS (
           SELECT ctid, row_number() OVER (ORDER BY created_at DESC, request_id COLLATE "C" DESC) AS rank
           FROM mcp_team_grants
         )
         UPDATE mcp_team_grants r
         SET status = 'revoked', revoked_at = $1
         FROM ranked
         WHERE r.ctid = ranked.ctid AND r.status <> 'revoked' AND ranked.rank > $2`,
        [now, MCP_TEAM_GLOBAL_LIMIT],
      );
    }
  }

  async requestMcpTeamGrant(
    orgId: string,
    sessionId: string,
    requesterUid: string,
    recipientPublicKey: string,
    now = Date.now(),
  ): Promise<{ result: McpTeamRequestResult; requestId?: string; expiresAt?: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockTeamSession(client, orgId, sessionId);
      await this.trimMcpTeamRows(client, now);
      const total = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM mcp_team_grants");
      if ((total.rows[0]?.count ?? 0) >= MCP_TEAM_GLOBAL_LIMIT) {
        await client.query("COMMIT");
        return { result: "limited" };
      }
      const found = await client.query<Row>(
        `SELECT * FROM sessions WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, sessionId],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { result: "missing" };
      }
      if (row.closed_at !== null) {
        await client.query("ROLLBACK");
        return { result: "closed" };
      }
      if (row.mcp_team_access !== true) {
        await client.query("ROLLBACK");
        return { result: "disabled" };
      }
      const pending = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM mcp_team_grants
         WHERE org_id = $1 AND session_id = $2 AND status = 'pending' AND expires_at > $3`,
        [orgId, sessionId, now],
      );
      if ((pending.rows[0]?.count ?? 0) >= MCP_TEAM_PENDING_LIMIT) {
        await client.query("ROLLBACK");
        return { result: "limited" };
      }
      const requestId = newId("mcp");
      const expiresAt = now + MCP_TEAM_REQUEST_TTL;
      await client.query(
        `INSERT INTO mcp_team_grants (org_id, session_id, request_id, requester_uid, recipient_public_key, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [orgId, sessionId, requestId, requesterUid, recipientPublicKey, now, expiresAt],
      );
      await this.trimMcpTeamRows(client, now);
      await client.query("COMMIT");
      return { result: "stored", requestId, expiresAt };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async mcpTeamRequest(
    orgId: string,
    sessionId: string,
    requesterUid: string,
    requestId: string,
    now = Date.now(),
  ): Promise<McpTeamRequest | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockTeamSession(client, orgId, sessionId);
      await this.trimMcpTeamRows(client, now);
      await client.query(
        `UPDATE mcp_team_grants r SET status = 'revoked', revoked_at = $5, bearer = NULL
         WHERE r.org_id = $1 AND r.session_id = $2 AND r.requester_uid = $3 AND r.request_id = $4
           AND r.status <> 'revoked' AND (
             (r.status = 'issued' AND COALESCE(r.grant_expires_at, 0) <= $5)
             OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.org_id = $1 AND s.id = $2
                            AND s.closed_at IS NULL AND s.mcp_team_access = TRUE)
             OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = $1 AND m.uid = $3))`,
        [orgId, sessionId, requesterUid, requestId, now],
      );
      /*
       * The credential is delivered exactly once, and it is out of the table
       * the moment it is delivered: the row lock makes two racing fetches
       * serialize, and only the first of them finds it still there.
       */
      const claim = await client.query<Row>(
        `SELECT * FROM mcp_team_grants
         WHERE org_id = $1 AND session_id = $2 AND requester_uid = $3 AND request_id = $4
           AND status = 'issued' AND bearer IS NOT NULL AND delivered_at IS NULL
         FOR UPDATE`,
        [orgId, sessionId, requesterUid, requestId],
      );
      if (claim.rows[0]) {
        await client.query(
          `UPDATE mcp_team_grants
           SET delivered_at = $5, bearer = NULL
           WHERE org_id = $1 AND session_id = $2 AND requester_uid = $3 AND request_id = $4`,
          [orgId, sessionId, requesterUid, requestId, now],
        );
        await client.query("COMMIT");
        return toMcpTeamRequest(claim.rows[0]);
      }
      const result = await client.query<Row>(
        `SELECT * FROM mcp_team_grants
         WHERE org_id = $1 AND session_id = $2 AND requester_uid = $3 AND request_id = $4`,
        [orgId, sessionId, requesterUid, requestId],
      );
      await client.query("COMMIT");
      return result.rows[0] ? toMcpTeamRequest(result.rows[0]) : null;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listMcpTeamRequests(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    deviceId: string,
    now = Date.now(),
  ): Promise<{ issues: McpTeamHostRequest[]; revocations: McpTeamHostRequest[] } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockTeamSession(client, orgId, sessionId);
      const found = await client.query<Row>(
        `SELECT * FROM sessions WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, sessionId],
      );
      const row = found.rows[0];
      if (!row || row.closed_at !== null || !teamPublisher(toSession(row, []), orgId, ownerUid, deviceId)) {
        await client.query("ROLLBACK");
        return null;
      }
      /*
       * Recheck every live row against the world as it is now: a requester
       * who left the organization, or a consent that just turned off,
       * revokes on the way so this poll carries the revocation.
       */
      await client.query(
        `UPDATE mcp_team_grants r
         SET status = 'revoked', revoked_at = $3
         WHERE r.org_id = $1 AND r.session_id = $2 AND r.status <> 'revoked'
           AND ($4::boolean = false
                OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = $1 AND m.uid = r.requester_uid))`,
        [orgId, sessionId, now, row.mcp_team_access === true],
      );
      await this.trimMcpTeamRows(client, now);
      const result = await client.query<Row>(
        `SELECT * FROM mcp_team_grants
         WHERE org_id = $1 AND session_id = $2
           AND ((status = 'pending' AND expires_at > $3) OR (status = 'revoked' AND grant_id IS NOT NULL))
         ORDER BY created_at ASC, request_id COLLATE "C" ASC`,
        [orgId, sessionId, now],
      );
      await client.query("COMMIT");
      const issues: McpTeamHostRequest[] = [];
      const revocations: McpTeamHostRequest[] = [];
      for (const entry of result.rows) {
        if (entry.status === "pending") {
          issues.push({
            requestId: entry.request_id as string,
            requesterUid: entry.requester_uid as string,
            action: "issue",
            expiresAt: Number(entry.expires_at),
          });
        } else {
          revocations.push({
            requestId: entry.request_id as string,
            requesterUid: entry.requester_uid as string,
            action: "revoke",
            grantId: entry.grant_id as string,
          });
        }
      }
      return { issues, revocations };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async reportMcpTeamGrant(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    deviceId: string,
    requestId: string,
    report: McpTeamGrantReport,
    now = Date.now(),
  ): Promise<McpTeamReportResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockTeamSession(client, orgId, sessionId);
      const found = await client.query<Row>(
        `SELECT * FROM sessions WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, sessionId],
      );
      const row = found.rows[0];
      if (!row || row.closed_at !== null || !teamPublisher(toSession(row, []), orgId, ownerUid, deviceId)) {
        await client.query("ROLLBACK");
        return "missing";
      }
      const state = await client.query<Row>(
        `SELECT * FROM mcp_team_grants WHERE org_id = $1 AND session_id = $2 AND request_id = $3 FOR UPDATE`,
        [orgId, sessionId, requestId],
      );
      const entry = state.rows[0];
      if (!entry) {
        await client.query("ROLLBACK");
        return "missing";
      }
      if (entry.status === "issued") {
        /* A retry: the first grant stands, and a re-minted one runs out alone. */
        await client.query("COMMIT");
        return "stored";
      }
      if (entry.status === "revoked") {
        await client.query("ROLLBACK");
        return "revoked";
      }
      if (Number(entry.expires_at) <= now) {
        await client.query(
          `UPDATE mcp_team_grants SET status = 'revoked', revoked_at = $3 WHERE org_id = $1 AND session_id = $2 AND request_id = $4`,
          [orgId, sessionId, now, requestId],
        );
        await client.query("COMMIT");
        return "expired";
      }
      const member = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM memberships WHERE org_id = $1 AND uid = $2`,
        [orgId, entry.requester_uid],
      );
      if ((member.rows[0]?.count ?? 0) === 0 || row.mcp_team_access !== true) {
        await client.query(
          `UPDATE mcp_team_grants SET status = 'revoked', revoked_at = $3 WHERE org_id = $1 AND session_id = $2 AND request_id = $4`,
          [orgId, sessionId, now, requestId],
        );
        await client.query("COMMIT");
        return "revoked";
      }
      const sealed = await sealTeamBearer(
        entry.recipient_public_key as string, sessionId, entry.requester_uid as string, requestId, report.bearer,
      );
      await client.query(
        `UPDATE mcp_team_grants
         SET status = 'issued', grant_id = $3, grant_expires_at = $4, bearer = $5,
             sealed_to_recipient = $6, issued_at = $7
         WHERE org_id = $1 AND session_id = $2 AND request_id = $8`,
        [orgId, sessionId, report.grantId, report.expiresAt, sealed, true, now, requestId],
      );
      await this.trimMcpTeamRows(client, now);
      await client.query("COMMIT");
      return "stored";
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async ackMcpTeamRevocation(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    deviceId: string,
    requestId: string,
    now = Date.now(),
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockTeamSession(client, orgId, sessionId);
      const found = await client.query<Row>(
        `SELECT * FROM sessions WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, sessionId],
      );
      const row = found.rows[0];
      if (!row || !teamPublisher(toSession(row, []), orgId, ownerUid, deviceId)) {
        await client.query("ROLLBACK");
        return false;
      }
      await this.trimMcpTeamRows(client, now);
      const result = await client.query(
        `DELETE FROM mcp_team_grants
         WHERE org_id = $1 AND session_id = $2 AND request_id = $3 AND status = 'revoked' AND grant_id IS NOT NULL`,
        [orgId, sessionId, requestId],
      );
      await client.query("COMMIT");
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeMcpTeamSession(orgId: string, sessionId: string, now = Date.now()): Promise<void> {
    const result = await this.pool.query(
      `UPDATE mcp_team_grants SET status = 'revoked', revoked_at = $3
       WHERE org_id = $1 AND session_id = $2 AND status <> 'revoked'`,
      [orgId, sessionId, now],
    );
    if ((result.rowCount ?? 0) > 0) await this.purgeTeamRows(now);
  }

  async revokeMcpTeamMember(orgId: string, requesterUid: string, now = Date.now()): Promise<void> {
    const result = await this.pool.query(
      `UPDATE mcp_team_grants SET status = 'revoked', revoked_at = $3
       WHERE org_id = $1 AND requester_uid = $2 AND status <> 'revoked'`,
      [orgId, requesterUid, now],
    );
    if ((result.rowCount ?? 0) > 0) await this.purgeTeamRows(now);
  }

  /** The opportunistic sweep outside a transaction, for the revocation hooks. */
  private async purgeTeamRows(now: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM mcp_team_grants
       WHERE (status = 'pending' AND expires_at <= $1::bigint - 3600000)
          OR (status = 'revoked' AND COALESCE(revoked_at, created_at) <= $1::bigint - 3600000)
          OR (status = 'issued' AND COALESCE(grant_expires_at, created_at) <= $1::bigint - 3600000)`,
      [now],
    );
  }

  async teamAuthorization(sessionId: string, requesterUid: string, grantId: string, now = Date.now()): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const rows = await client.query<Row>(
        `SELECT org_id, closed_at, mcp_team_access FROM sessions WHERE id = $1`,
        [sessionId],
      );
      if (rows.rows.length === 0) return false;
      for (const row of rows.rows) {
        if (row.closed_at !== null || row.mcp_team_access !== true) return false;
        const member = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM memberships WHERE org_id = $1 AND uid = $2`,
          [row.org_id, requesterUid],
        );
        if ((member.rows[0]?.count ?? 0) === 0) return false;
        const grant = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM mcp_team_grants
           WHERE org_id = $1 AND session_id = $2 AND requester_uid = $3 AND grant_id = $4
             AND status = 'issued' AND grant_expires_at > $5`,
          [row.org_id, sessionId, requesterUid, grantId, now],
        );
        if ((grant.rows[0]?.count ?? 0) === 0) return false;
      }
      return true;
    } finally {
      client.release();
    }
  }

  async upsertSession(session: SessionRecord): Promise<boolean> {
    /*
     * `xmax = 0` distinguishes an insert from an update on the conflicting
     * row, which is the answer the caller wants and the only way to get it
     * without a second round trip.
     *
     * A persistent session re-registers on every restart, carrying the owner
     * as assignee. Letting that through would silently undo a handoff, so an
     * assignment already made stands.
     *
     * A restart that names nothing keeps the name somebody gave it, in the
     * terminal or in the browser. Only a name it does send replaces it.
     *
     * A new session's daily-briefing switch is the one consent it may start
     * with already set: the owner's saved default, read from the membership
     * row inside the insert. The DO UPDATE half never touches the column, so
     * a re-registration cannot move a choice the owner already made.
     */
    const row = await this.row(
      `INSERT INTO sessions
         (uid, id, org_id, owner_uid, assignee_uid, assignee_uids, share_url, command, origin, name,
          read_only, encrypted, persistent, host, started_at, closed_at, exit_code,
          daily_briefing_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               COALESCE(
                 (SELECT daily_briefing_default FROM memberships
                  WHERE org_id = $3 AND uid = COALESCE($4, $1)),
                 FALSE
               ))
       ON CONFLICT (uid, id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         owner_uid = EXCLUDED.owner_uid,
         assignee_uid = sessions.assignee_uid,
         assignee_uids = sessions.assignee_uids,
         share_url = EXCLUDED.share_url,
         command = EXCLUDED.command,
         origin = EXCLUDED.origin,
         name = COALESCE(EXCLUDED.name, sessions.name),
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
    /*
     * A snapshot is bound to one incarnation under one owner. Clean anything
     * the current row no longer matches, so a restart or a handoff invalidates
     * the old run's snapshot in the same call, with no intervening read.
     */
    await this.pool.query(
      `DELETE FROM jev_assessments ja
       WHERE ja.session_id = $1 AND ja.org_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.id = ja.session_id AND s.org_id = ja.org_id
             AND COALESCE(s.owner_uid, s.uid) = ja.owner_uid
             AND s.started_at = ja.started_at
             AND s.closed_at IS NULL
         )`,
      [session.id, session.orgId ?? null],
    );
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
    if (["closedAt", "ownerUid", "startedAt"].some((key) => key in columns)) {
      /*
       * A close, a handoff or a new incarnation invalidates the snapshot in
       * the same call, so a later reopen or handback cannot resurrect it.
       */
      await this.pool.query(
        `DELETE FROM jev_assessments
         WHERE session_id = $2
           AND org_id = COALESCE((SELECT org_id FROM sessions WHERE uid = $1 AND id = $2), '')`,
        [uid, id],
      );
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

  async renameSession(
    orgId: string,
    id: string,
    name: string | undefined,
  ): Promise<SessionRecord | null> {
    const row = await this.row(
      `UPDATE sessions SET name = $3 WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, id, name ?? null],
    );
    return row ? (await this.hydrate([row]))[0] : null;
  }

  /**
   * One statement, one row: the three switches move together, and the owner
   * clause in the WHERE means a caller who is not the row's owner (a legacy
   * row's uid standing in for a missing owner) updates nothing and learns it
   * from the null rather than from a second, racy read.
   */
  async setSessionAutomationConsent(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    consent: Partial<SessionAutomationConsent>,
  ): Promise<SessionRecord | null> {
    const client = await this.pool.connect();
    let row: Row | undefined;
    try {
      await client.query("BEGIN");
      // Match request/report lock order: global, session advisory, session row.
      await this.lockTeamSession(client, orgId, sessionId);
      const updated = await client.query<Row>(
        `UPDATE sessions
         SET mcp_team_access = COALESCE($4::boolean, mcp_team_access),
             daily_briefing_enabled = COALESCE($5::boolean, daily_briefing_enabled),
             daily_briefing_team_access = COALESCE($6::boolean, daily_briefing_team_access)
         WHERE org_id = $1 AND id = $2 AND COALESCE(owner_uid, uid) = $3 RETURNING *`,
        [orgId, sessionId, ownerUid, consent.mcpTeamAccess, consent.dailyBriefingEnabled, consent.dailyBriefingTeamAccess],
      );
      row = updated.rows[0];
      if (row && consent.mcpTeamAccess === false) {
        await client.query(
          `UPDATE mcp_team_grants SET status = 'revoked', revoked_at = $3, bearer = NULL
           WHERE org_id = $1 AND session_id = $2 AND status <> 'revoked'`,
          [orgId, sessionId, Date.now()],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the failure. */ }
      throw error;
    } finally {
      client.release();
    }
    return row ? (await this.hydrate([row]))[0] : null;
  }

  async dailyBriefingDefault(orgId: string, uid: string): Promise<boolean> {
    const row = await this.row(
      "SELECT daily_briefing_default FROM memberships WHERE org_id = $1 AND uid = $2",
      [orgId, uid],
    );
    return row?.daily_briefing_default === true;
  }

  /**
   * One transaction: the default is saved and the owner's sessions switched
   * together, so a failure in between cannot leave a default that was never
   * applied or sessions that were switched without the default behind them.
   */
  async setDailyBriefingPreference(
    orgId: string,
    uid: string,
    enabled: boolean,
    applyToExisting: boolean,
  ): Promise<{ enabled: boolean; applied: number } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query(
        "UPDATE memberships SET daily_briefing_default = $3 WHERE org_id = $1 AND uid = $2",
        [orgId, uid, enabled],
      );
      if ((saved.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      let applied = 0;
      if (applyToExisting) {
        /*
         * The owner's sessions in this organization only: a legacy row's uid
         * stands in for a missing owner, and a session somebody merely
         * assigned to this person is not theirs to switch. Nothing but the
         * briefing switch moves.
         */
        const updated = await client.query(
          `UPDATE sessions SET daily_briefing_enabled = $3
           WHERE org_id = $1 AND COALESCE(owner_uid, uid) = $2`,
          [orgId, uid, enabled],
        );
        applied = updated.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { enabled, applied };
    } catch (error) {
      /*
       * A ROLLBACK on a connection that is already failing can throw too. It
       * must not replace the failure that got us here: that error is the one
       * that says what actually went wrong.
       */
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The original failure stands. */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /*
   * The row only. Sealed password copies go with it because they are useless
   * without it, and the audit trail deliberately does not: removing a session
   * is an audited act and the record of it outlives the subject.
   */
  async deleteSession(orgId: string, id: string): Promise<boolean> {
    /* A snapshot does not outlive the session row it was bound to. */
    await this.pool.query("DELETE FROM jev_assessments WHERE org_id = $1 AND session_id = $2", [orgId, id]);
    const result = await this.pool.query("DELETE FROM sessions WHERE org_id = $1 AND id = $2", [
      orgId,
      id,
    ]);
    if ((result.rowCount ?? 0) > 0) await this.revokeMcpTeamSession(orgId, id);
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

  async rotateSessionCredentials(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    shareUrl: string,
    shares: SessionKeyShare[],
  ): Promise<SessionRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<Row>(
        `SELECT * FROM sessions
         WHERE org_id = $1 AND id = $2 AND COALESCE(owner_uid, uid) = $3 AND encrypted = true
         FOR UPDATE`,
        [orgId, sessionId, ownerUid],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const sessionUid = row.uid as string;
      await client.query(
        "UPDATE sessions SET share_url = $4 WHERE org_id = $1 AND id = $2 AND uid = $3",
        [orgId, sessionId, sessionUid, shareUrl],
      );
      await client.query(
        "DELETE FROM session_key_shares WHERE session_uid = $1 AND session_id = $2",
        [sessionUid, sessionId],
      );
      for (const share of shares) {
        await client.query(
          `INSERT INTO session_key_shares
             (session_uid, session_id, uid, sender_public_key, sealed)
           VALUES ($1, $2, $3, $4, $5)`,
          [sessionUid, sessionId, share.uid, share.senderPublicKey, share.sealed],
        );
      }
      await client.query("COMMIT");
      return toSession({ ...row, share_url: shareUrl }, shares);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  async updateAccountKeyWrap(uid: string, expectedVersion: number, recoveryWrap: string, updatedAt: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE account_keys SET recovery_wrap = $3, updated_at = $4
       WHERE uid = $1 AND version = $2`,
      [uid, expectedVersion, recoveryWrap, updatedAt],
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
      // Serialize with team request/issue/consent transactions before taking
      // session or membership row locks. Capture ownership before deletion or
      // reassignment removes the binding needed to invalidate these grants.
      await client.query("SELECT pg_advisory_xact_lock($1)", [MCP_TEAM_GLOBAL_LOCK]);
      await client.query(
        `UPDATE mcp_team_grants r
         SET status = 'revoked', revoked_at = $3, bearer = NULL
         WHERE r.requester_uid = $1
            OR ($2::text IS NOT NULL AND r.org_id = $2)
            OR EXISTS (
              SELECT 1 FROM sessions s
              WHERE s.org_id = r.org_id AND s.id = r.session_id
                AND (s.uid = $1 OR s.owner_uid = $1)
            )`,
        [uid, plan.orgId && plan.dissolve ? plan.orgId : null, now],
      );
      if (plan.orgId && plan.dissolve) {
        /* Key shares go with their sessions, through the foreign key's cascade. */
        for (const table of [
          "sessions",
          "audit_events",
          "comments",
          "notifications",
          "invites",
          "memberships",
          "external_analysis_consents",
          "jev_assessments",
          "jev_budget",
        ]) {
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
        "DELETE FROM account_activity WHERE uid = $1",
        /* The keep goes with the account. It is nobody else's progress. */
        "DELETE FROM game_profiles WHERE uid = $1",
        /* Jev state is account-scoped: it goes with the account. */
        "DELETE FROM external_analysis_consents WHERE owner_uid = $1",
        "DELETE FROM jev_assessments WHERE owner_uid = $1",
        "DELETE FROM jev_budget WHERE owner_uid = $1",
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
      /* A session that just lost its owner must not keep the old run's rows,
         even outside the dissolve path. */
      await client.query(
        `DELETE FROM jev_assessments ja
         WHERE NOT EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.id = ja.session_id AND s.org_id = ja.org_id
             AND COALESCE(s.owner_uid, s.uid) = ja.owner_uid
             AND s.closed_at IS NULL
         )`,
      );
      await client.query("UPDATE audit_events SET actor_email = $2 WHERE actor_uid = $1", [
        uid,
        DELETED_ACTOR_EMAIL,
      ]);
      /* The words stay, as a message to the service; who sent them does not. */
      await client.query("UPDATE feedback SET uid = '', email = $2, can_reply = FALSE WHERE uid = $1", [
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
     *
     * The saved briefing default is the account's, not this row's. A re-login
     * or a move between organizations rewrites the row, and letting that reset
     * a choice the person made would be a consent revoked without being asked.
     * An absent incoming value ($8 null) therefore keeps the stored one; a
     * value the caller actually carries still stands.
     */
    await this.pool.query(
      `INSERT INTO memberships
         (org_id, uid, email, name, role, joined_at, public_key, daily_briefing_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, FALSE))
       ON CONFLICT (uid) DO UPDATE SET
         org_id = EXCLUDED.org_id, email = EXCLUDED.email, name = EXCLUDED.name,
         role = EXCLUDED.role, joined_at = EXCLUDED.joined_at,
         public_key = EXCLUDED.public_key,
         daily_briefing_default = CASE
           WHEN $8 IS NULL THEN memberships.daily_briefing_default
           ELSE $8
         END`,
      [
        membership.orgId,
        membership.uid,
        membership.email,
        membership.name,
        membership.role,
        membership.joinedAt,
        membership.publicKey ?? null,
        membership.dailyBriefingDefault ?? null,
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "DELETE FROM memberships WHERE org_id = $1 AND uid = $2",
        [orgId, uid],
      );
      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          `DELETE FROM session_key_shares AS keys
           USING sessions
           WHERE keys.session_uid = sessions.uid AND keys.session_id = sessions.id
             AND sessions.org_id = $1 AND keys.uid = $2`,
          [orgId, uid],
        );
        /* A listing is not a connection: their live team requests go with them. */
        await client.query(
          `UPDATE mcp_team_grants SET status = 'revoked', revoked_at = $3
           WHERE org_id = $1 AND requester_uid = $2 AND status <> 'revoked'`,
          [orgId, uid, Date.now()],
        );
      }
      await client.query("COMMIT");
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  /* One conditional update, so a copy that is not there is never created. */
  async replaceOwnTeamKeyShare(share: TeamKeyShare): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE team_key_shares
       SET sender_uid = $4, sealed = $5, created_at = $6
       WHERE org_id = $1 AND uid = $2 AND version = $3`,
      [share.orgId, share.uid, share.version, share.senderUid, share.sealed, share.createdAt],
    );
    return (result.rowCount ?? 0) > 0;
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

  async notificationsFor(orgId: string, uid: string, limit = 100): Promise<Notification[]> {
    const rows = await this.rows(
      'SELECT * FROM notifications WHERE org_id = $1 AND uid = $2 ORDER BY at DESC, id COLLATE "C" DESC LIMIT $3',
      [orgId, uid, limit],
    );
    return rows.map(toNotification);
  }

  async markNotificationRead(orgId: string, uid: string, id: string, now = Date.now()): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE notifications SET read_at = $4 WHERE org_id = $1 AND uid = $2 AND id = $3 AND read_at IS NULL",
      [orgId, uid, id, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markAllNotificationsRead(orgId: string, uid: string, now = Date.now()): Promise<number> {
    const result = await this.pool.query(
      "UPDATE notifications SET read_at = $3 WHERE org_id = $1 AND uid = $2 AND read_at IS NULL",
      [orgId, uid, now],
    );
    return result.rowCount ?? 0;
  }

  /* ---- Feedback ---- */

  async putFeedback(feedback: Feedback): Promise<void> {
    await this.pool.query(
      `INSERT INTO feedback (id, uid, email, org_id, kind, body, surface, route, app_version, user_agent, can_reply, context, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        feedback.id,
        feedback.uid,
        feedback.email,
        feedback.orgId ?? null,
        feedback.kind,
        feedback.body,
        feedback.surface,
        feedback.route,
        feedback.appVersion,
        feedback.userAgent,
        feedback.canReply,
        JSON.stringify(feedback.context),
        feedback.at,
      ],
    );
  }

  async feedback(limit = 100): Promise<Feedback[]> {
    const rows = await this.rows(
      'SELECT * FROM feedback ORDER BY at DESC, id COLLATE "C" DESC LIMIT $1',
      [limit],
    );
    return rows.map(toFeedback);
  }

  /* ---- Account activity ---- */

  /*
   * One UPDATE per request, which does nothing until the hour is up; the day
   * row is written only when the update did something, so a busy account
   * costs one extra statement an hour and an idle one costs nothing.
   */
  async touchMembership(uid: string, now = Date.now(), resolutionMs = 60 * 60_000): Promise<void> {
    const moved = await this.pool.query(
      `UPDATE memberships SET last_seen_at = $2
       WHERE uid = $1 AND (last_seen_at IS NULL OR $2 - last_seen_at >= $3)`,
      [uid, now, resolutionMs],
    );
    if ((moved.rowCount ?? 0) === 0) return;
    await this.pool.query(
      "INSERT INTO account_activity (uid, day) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [uid, Math.floor(now / DAY_MS) * DAY_MS],
    );
  }

  async accountActivity(isInternal: (email: string) => boolean = () => false): Promise<AccountActivity[]> {
    const members = await this.rows("SELECT uid, email, joined_at FROM memberships");
    const days = await this.rows("SELECT uid, day FROM account_activity ORDER BY day");
    const byUid = new Map<string, number[]>();
    for (const row of days) {
      const list = byUid.get(row.uid as string) ?? [];
      list.push(row.day as number);
      byUid.set(row.uid as string, list);
    }
    return members.map((row) => ({
      joinedAt: row.joined_at as number,
      days: byUid.get(row.uid as string) ?? [],
      internal: isInternal((row.email as string | null) ?? ""),
    }));
  }

  /* ---- The saved game ---- */

  async gameProfile(uid: string): Promise<GameProfile | null> {
    const rows = await this.rows("SELECT * FROM game_profiles WHERE uid = $1", [uid]);
    const row = rows[0];
    if (!row) return null;
    return {
      uid: row.uid as string,
      characterClass: row.character_class as string,
      skinId: row.skin_id as string,
      liveryId: (row.livery_id as string) ?? "",
      owned: readOwned(row.owned),
      spent: Number(row.spent),
      gathering: row.gathering === true,
      tokens: Number(row.tokens),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async putGameProfile(profile: GameProfile): Promise<void> {
    await this.pool.query(
      `INSERT INTO game_profiles
         (uid, character_class, skin_id, livery_id, owned, spent, gathering, tokens, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (uid) DO UPDATE SET
         character_class = EXCLUDED.character_class,
         skin_id = EXCLUDED.skin_id,
         livery_id = EXCLUDED.livery_id,
         owned = EXCLUDED.owned,
         spent = EXCLUDED.spent,
         gathering = EXCLUDED.gathering,
         tokens = EXCLUDED.tokens,
         updated_at = EXCLUDED.updated_at`,
      [
        profile.uid,
        profile.characterClass,
        profile.skinId,
        profile.liveryId,
        JSON.stringify(profile.owned),
        profile.spent,
        profile.gathering,
        profile.tokens,
        profile.createdAt,
        profile.updatedAt,
      ],
    );
  }

  /**
   * One run, and its cost, in a single transaction.
   *
   * The total on the profile is the sum of these rows, so the two have to move
   * together or the vial can disagree with the breakdown behind it. The insert
   * makes the profile when there is not one: the agent reporting is proof the
   * account is real, and losing somebody's first run because they had not
   * opened the game yet would be a hole in the account nobody could explain.
   */
  async recordCollectionRun(run: GameCollectionRun): Promise<void> {
    /*
     * One statement, so the row and the total cannot come apart.
     *
     * The total on the profile is the sum of these rows, and the second insert
     * draws its numbers from what the first one actually wrote -- so a run that
     * was already recorded inserts nothing and therefore adds nothing. Written
     * as two statements in a transaction, the conflict clause skipped the
     * duplicate row and the token add ran anyway, which doubled the bill of any
     * agent that reported, lost the reply and retried. The bill is the one
     * number in this game that stands for real money.
     *
     * The profile is made when there is not one: the agent reporting is proof
     * the account is real, and losing somebody's first run because they had not
     * opened the keep yet would be a hole nobody could explain afterwards.
     */
    await this.pool.query(
      `WITH recorded AS (
         INSERT INTO game_collection_runs
           (id, uid, device_id, device_name, ran_at, tokens,
            pull_requests, commits, insertions, deletions, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING
         RETURNING uid, tokens, ran_at
       )
       INSERT INTO game_profiles (uid, gathering, tokens, created_at, updated_at)
       SELECT uid, TRUE, tokens, ran_at, ran_at FROM recorded
       ON CONFLICT (uid) DO UPDATE SET
         tokens = game_profiles.tokens + EXCLUDED.tokens,
         updated_at = EXCLUDED.updated_at`,
      [
        run.id,
        run.uid,
        run.deviceId,
        run.deviceName,
        run.ranAt,
        run.tokens,
        run.pullRequests,
        run.commits,
        run.insertions,
        run.deletions,
        run.error,
      ],
    );
  }

  async listCollectionRuns(uid: string, limit = 20): Promise<GameCollectionRun[]> {
    const rows = await this.rows(
      `SELECT * FROM game_collection_runs
       WHERE uid = $1 ORDER BY ran_at DESC LIMIT $2`,
      [uid, limit],
    );
    return rows.map((row) => ({
      id: row.id as string,
      uid: row.uid as string,
      deviceId: row.device_id as string,
      deviceName: row.device_name as string,
      ranAt: Number(row.ran_at),
      tokens: Number(row.tokens),
      pullRequests: Number(row.pull_requests),
      commits: Number(row.commits),
      insertions: Number(row.insertions),
      deletions: Number(row.deletions),
      error: row.error as string,
    }));
  }

  /* ---- App events ---- */

  async recordAppEvent(event: AppEvent, now = Date.now(), internal = false): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_events (event, day, internal, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (event, day, internal) DO UPDATE SET count = app_events.count + 1`,
      [event, Math.floor(now / DAY_MS) * DAY_MS, internal],
    );
  }

  async appEvents(sinceDay: number): Promise<AppEventCount[]> {
    const rows = await this.rows(
      `SELECT event, SUM(count) AS count FROM app_events
       WHERE day >= $1 AND internal = FALSE GROUP BY event ORDER BY event`,
      [sinceDay],
    );
    return rows.map((row) => ({ event: row.event as AppEvent, count: Number(row.count) }));
  }

  /* ---- Housekeeping ---- */

  async purgeExpired(now = Date.now()): Promise<void> {
    await this.pool.query("DELETE FROM account_activity WHERE day < $1", [now - ACCOUNT_ACTIVITY_MEMORY_MS]);
    await this.pool.query("DELETE FROM app_events WHERE day < $1", [now - ACCOUNT_ACTIVITY_MEMORY_MS]);
    await this.pool.query("DELETE FROM auth_codes WHERE expires_at <= $1", [now]);
    /* Finished commands are only kept long enough to be reported back. */
    await this.pool.query("DELETE FROM agent_commands WHERE done_at IS NOT NULL AND done_at < $1", [
      now - 10 * 60_000,
    ]);
    await this.pool.query("DELETE FROM deleted_accounts WHERE deleted_at <= $1", [
      now - DELETED_ACCOUNT_MEMORY_MS,
    ]);
    /* Flow rows are a live feed: the purge is what keeps the table a feed. */
    await this.pool.query("DELETE FROM mcp_flows WHERE expires_at <= $1", [now]);
    /* Assessment rows are short-lived the same way; budget rows age out of
       the sliding window. */
    await this.pool.query("DELETE FROM jev_assessments WHERE expires_at <= $1", [now]);
    await this.pool.query("DELETE FROM jev_budget WHERE at <= $1", [now - JEV_BUDGET.windowMs]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
