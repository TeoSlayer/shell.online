import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { CONTENT_INTERVAL_MS, contentPublisher, type SessionContent, type SessionContentPolicy, type ContentWriteResult } from "./session-content";
import {
  MCP_FLOW_LIMIT,
  mcpFlowAllowedBindings,
  mcpFlowBinding,
  mcpFlowExpiry,
  trimMcpFlowRows,
  type McpFlow,
  type McpFlowEvent,
  type McpFlowRow,
} from "./mcp-flows";
import type { Invite, Membership, Organization, Role } from "./orgs";
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
 * Orders records that share a timestamp.
 *
 * Two audit events a millisecond apart are common, and two in the same
 * millisecond are not rare. Sorting on the timestamp alone leaves their order
 * to the backing store, so a trace can reorder between two reads of the same
 * history. The id breaks the tie, compared by code unit so that Postgres
 * ordering the same column with COLLATE "C" agrees.
 */
function byTime<T>(time: (record: T) => number, id: (record: T) => string, descending = false) {
  return (a: T, b: T): number => {
    const difference = descending ? time(b) - time(a) : time(a) - time(b);
    if (difference !== 0) return difference;
    /* The tiebreaker follows the direction of the sort, as ORDER BY does. */
    const left = descending ? id(b) : id(a);
    const right = descending ? id(a) : id(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

/* Typed input, which the browser seals, as opposed to what the service writes itself. */
function isTyped(entry: AuditEvent): boolean {
  return entry.kind === "input" || entry.kind === "interrupt";
}

function isSealed(text: string): boolean {
  return text.startsWith("a1.");
}

interface Shape {
  sessionContent: { sessionUid: string; sessionId: string; generation: string; content?: SessionContent; publishedAt?: number }[];
  mcpFlows: McpFlowRow[];
  codes: AuthorizationCode[];
  tokens: CliToken[];
  sessions: SessionRecord[];
  commands: AgentCommand[];
  organizations: Organization[];
  memberships: Membership[];
  invites: Invite[];
  audit: AuditEvent[];
  comments: Comment[];
  notifications: Notification[];
  feedback: Feedback[];
  accountKeys: AccountKey[];
  deletedAccounts: { uid: string; deletedAt: number }[];
  accountActivity: { uid: string; day: number }[];
  appEvents: { event: AppEvent; day: number; count: number; internal?: boolean }[];
  teamKeys: TeamKey[];
  gameProfiles: GameProfile[];
  collectionRuns: GameCollectionRun[];
  teamKeyShares: TeamKeyShare[];
}

const EMPTY: Shape = {
  sessionContent: [],
  mcpFlows: [],
  codes: [], tokens: [], sessions: [], commands: [],
  organizations: [], memberships: [], invites: [], audit: [],
  comments: [], notifications: [], feedback: [], accountKeys: [], deletedAccounts: [],
  accountActivity: [], appEvents: [], teamKeys: [], teamKeyShares: [], gameProfiles: [], collectionRuns: [],
};

/**
 * The whole dataset in memory, optionally mirrored to a file.
 *
 * This is what the tests run against, and what a single developer can run
 * without a database. It is not what production uses: every mutation rewrites
 * the whole file, and nothing coordinates two processes.
 */
export class MemoryStore implements Store {
  private data: Shape;

  constructor(private readonly path: string | null) {
    this.data = this.read();
    this.migrate();
  }

  /*
   * Fills in fields added after a record was first written. Doing it once on
   * load keeps every reader simple: a token in memory always has an id and a
   * lastSeenAt, so nothing downstream has to cope with a half-shaped record.
   */
  private migrate(): void {
    let changed = false;
    for (const token of this.data.tokens) {
      if (!token.id) {
        token.id = `dev_${randomBytes(16).toString("hex")}`;
        changed = true;
      }
      if (typeof token.lastSeenAt !== "number") {
        token.lastSeenAt = token.createdAt;
        changed = true;
      }
    }
    for (const session of this.data.sessions) {
      if (!session.assigneeUids) {
        session.assigneeUids = session.assigneeUid ? [session.assigneeUid] : [];
        changed = true;
      }
      /* A row from before the automation consent reads as "everything off". */
      if (typeof session.mcpTeamAccess !== "boolean") {
        session.mcpTeamAccess = false;
        changed = true;
      }
      if (typeof session.dailyBriefingEnabled !== "boolean") {
        session.dailyBriefingEnabled = false;
        changed = true;
      }
      if (typeof session.dailyBriefingTeamAccess !== "boolean") {
        session.dailyBriefingTeamAccess = false;
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  static memory(): MemoryStore {
    return new MemoryStore(null);
  }

  private read(): Shape {
    if (!this.path) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Shape>;
      return {
        codes: parsed.codes ?? [],
        tokens: parsed.tokens ?? [],
        sessions: parsed.sessions ?? [],
        sessionContent: parsed.sessionContent ?? [],
        mcpFlows: parsed.mcpFlows ?? [],
        commands: parsed.commands ?? [],
        organizations: parsed.organizations ?? [],
        memberships: parsed.memberships ?? [],
        invites: parsed.invites ?? [],
        audit: parsed.audit ?? [],
        comments: parsed.comments ?? [],
        notifications: parsed.notifications ?? [],
        feedback: parsed.feedback ?? [],
        accountKeys: parsed.accountKeys ?? [],
        deletedAccounts: parsed.deletedAccounts ?? [],
        accountActivity: parsed.accountActivity ?? [],
        appEvents: parsed.appEvents ?? [],
        teamKeys: parsed.teamKeys ?? [],
        gameProfiles: parsed.gameProfiles ?? [],
        collectionRuns: parsed.collectionRuns ?? [],
        teamKeyShares: parsed.teamKeyShares ?? [],
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    /* Write to a sibling then rename, so a crash cannot leave a half file. */
    const temporary = join(dirname(this.path), `.${Date.now()}.tmp`);
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  async putCode(code: AuthorizationCode): Promise<void> {
    this.data.codes = this.data.codes.filter((entry) => entry.code !== code.code);
    this.data.codes.push(code);
    this.flush();
  }

  /*
   * Marks the code consumed and reports whether it already was. Returning the
   * flag rather than comparing timestamps keeps replay detection independent
   * of clock ordering between the stamp and the caller's own clock.
   */
  async takeCode(
    code: string,
    now = Date.now(),
  ): Promise<{ entry: AuthorizationCode; alreadyConsumed: boolean } | null> {
    const found = this.data.codes.find((entry) => entry.code === code);
    if (!found) return null;
    const alreadyConsumed = found.consumedAt !== undefined;
    if (!alreadyConsumed) {
      found.consumedAt = now;
      this.flush();
    }
    return { entry: found, alreadyConsumed };
  }

  async putToken(token: CliToken): Promise<void> {
    this.data.tokens.push(token);
    this.flush();
  }

  async findByAccessHash(hash: string): Promise<CliToken | null> {
    return this.data.tokens.find((entry) => entry.accessHash === hash) ?? null;
  }

  async findByRefreshHash(hash: string): Promise<CliToken | null> {
    return this.data.tokens.find((entry) => entry.refreshHash === hash) ?? null;
  }

  async updateToken(refreshHash: string, patch: Partial<CliToken>): Promise<void> {
    const token = this.data.tokens.find((entry) => entry.refreshHash === refreshHash);
    if (!token) return;
    Object.assign(token, patch);
    this.flush();
  }

  /*
   * Touching lastSeenAt on every authenticated call would mean a write per
   * request. The resolution only needs to be useful to a person reading a
   * device list, so it settles for a minute.
   */
  async touchToken(id: string, now = Date.now(), resolutionMs = 60_000): Promise<void> {
    const token = this.data.tokens.find((entry) => entry.id === id);
    if (!token || now - token.lastSeenAt < resolutionMs) return;
    token.lastSeenAt = now;
    this.flush();
  }

  /*
   * Scoped by uid so a machine id cannot address another account's device,
   * and to live rows so that unlinking a machine is not undone by the next
   * login on it. Two rows can share a machine id -- two logins racing each
   * other -- so the newest wins, which is the one a device list shows first.
   */
  async deviceForMachine(uid: string, machineId: string): Promise<CliToken | null> {
    const matches = this.data.tokens
      .filter((entry) => entry.uid === uid && entry.machineId === machineId && !entry.revokedAt)
      .sort(byTime<CliToken>((t) => t.createdAt, (t) => t.id, true));
    return matches[0] ?? null;
  }

  async machineForDevice(uid: string, deviceId: string): Promise<string | null> {
    /* Revoked rows count: the point is to find where a dead device lived. */
    const token = this.data.tokens.find((entry) => entry.uid === uid && entry.id === deviceId);
    return token?.machineId ?? null;
  }

  async setMemberKey(uid: string, publicKey: string): Promise<void> {
    const membership = this.data.memberships.find((entry) => entry.uid === uid);
    if (!membership || membership.publicKey === publicKey) return;
    membership.publicKey = publicKey;
    this.flush();
  }

  /** Stores sealed copies of a session password, replacing any for the same uid. */
  async putKeyShares(orgId: string, sessionId: string, shares: SessionKeyShare[]): Promise<boolean> {
    const session = await this.sessionInOrg(orgId, sessionId);
    if (!session) return false;
    const kept = (session.keyShares ?? []).filter(
      (share) => !shares.some((incoming) => incoming.uid === share.uid),
    );
    session.keyShares = [...kept, ...shares];
    this.flush();
    return true;
  }

  async rotateSessionCredentials(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    shareUrl: string,
    shares: SessionKeyShare[],
  ): Promise<SessionRecord | null> {
    const session = await this.sessionInOrg(orgId, sessionId);
    if (!session || (session.ownerUid ?? session.uid) !== ownerUid || !session.encrypted) return null;
    session.shareUrl = shareUrl;
    this.invalidateContent(session);
    session.keyShares = [...shares];
    this.flush();
    return session;
  }

  async accountKey(uid: string): Promise<AccountKey | null> {
    const found = this.data.accountKeys.find((entry) => entry.uid === uid);
    return found ? { ...found } : null;
  }

  async putAccountKey(key: AccountKey, expectedVersion?: number): Promise<boolean> {
    const index = this.data.accountKeys.findIndex((entry) => entry.uid === key.uid);
    if (expectedVersion === undefined) {
      if (index >= 0) return false;
      this.data.accountKeys.push({ ...key });
    } else {
      if (index < 0 || this.data.accountKeys[index].version !== expectedVersion) return false;
      const previous = this.data.accountKeys[index];
      if (previous.version !== key.version || previous.publicKey !== key.publicKey) {
        for (const session of this.data.sessions) {
          if ((session.ownerUid ?? session.uid) === key.uid) this.invalidateContent(session);
        }
      }
      this.data.accountKeys[index] = { ...key };
    }
    this.flush();
    return true;
  }

  async updateAccountKeyWrap(uid: string, expectedVersion: number, recoveryWrap: string, updatedAt: number): Promise<boolean> {
    const found = this.data.accountKeys.find((entry) => entry.uid === uid && entry.version === expectedVersion);
    if (!found) return false;
    found.recoveryWrap = recoveryWrap;
    found.updatedAt = updatedAt;
    this.flush();
    return true;
  }

  async deleteAccount(uid: string, plan: AccountDeletion, now = Date.now()): Promise<void> {
    const data = this.data;
    const { orgId } = plan;
    if (orgId && plan.dissolve) {
      data.organizations = data.organizations.filter((entry) => entry.id !== orgId);
      data.memberships = data.memberships.filter((entry) => entry.orgId !== orgId);
      data.invites = data.invites.filter((entry) => entry.orgId !== orgId);
      data.sessions = data.sessions.filter((entry) => entry.orgId !== orgId);
      data.audit = data.audit.filter((entry) => entry.orgId !== orgId);
      data.comments = data.comments.filter((entry) => entry.orgId !== orgId);
      data.notifications = data.notifications.filter((entry) => entry.orgId !== orgId);
    }
    if (orgId && plan.successorUid) {
      const successor = data.memberships.find(
        (entry) => entry.orgId === orgId && entry.uid === plan.successorUid,
      );
      if (successor) successor.role = "owner";
    }

    data.memberships = data.memberships.filter((entry) => entry.uid !== uid);
    data.codes = data.codes.filter((entry) => entry.uid !== uid);
    data.tokens = data.tokens.filter((entry) => entry.uid !== uid);
    data.commands = data.commands.filter((entry) => entry.uid !== uid);
    data.sessions = data.sessions.filter((entry) => entry.uid !== uid);
    data.sessionContent = data.sessionContent.filter((entry) => data.sessions.some((session) => session.uid === entry.sessionUid && session.id === entry.sessionId));
    for (const session of data.sessions) {
      if (session.keyShares) {
        session.keyShares = session.keyShares.filter((share) => share.uid !== uid);
      }
      const assignees = session.assigneeUids ?? [];
      if (assignees.includes(uid) || session.assigneeUid === uid) {
        session.assigneeUids = assignees.filter((entry) => entry !== uid);
        if (session.assigneeUid === uid) session.assigneeUid = session.assigneeUids[0];
      }
      if (session.ownerUid === uid) {
        this.invalidateContent(session);
        session.ownerUid = session.uid;
      }
    }
    for (const invite of data.invites) {
      /* The address an invite was sent to is theirs once they accepted it. */
      if (invite.acceptedBy === uid) delete invite.email;
    }
    data.accountKeys = data.accountKeys.filter((entry) => entry.uid !== uid);
    /* The keep goes with the account. It is nobody else's progress. */
    data.gameProfiles = data.gameProfiles.filter((entry) => entry.uid !== uid);
    data.accountActivity = data.accountActivity.filter((entry) => entry.uid !== uid);
    data.comments = data.comments.filter((entry) => entry.authorUid !== uid);
    data.notifications = data.notifications.filter(
      (entry) => entry.uid !== uid && entry.actorUid !== uid,
    );
    for (const event of data.audit) {
      if (event.actorUid === uid) event.actorEmail = DELETED_ACTOR_EMAIL;
    }
    /* The words stay, as a message to the service; who sent them does not. */
    for (const entry of data.feedback) {
      if (entry.uid !== uid) continue;
      entry.uid = "";
      entry.email = DELETED_ACTOR_EMAIL;
      entry.canReply = false;
    }
    data.deletedAccounts = [
      ...data.deletedAccounts.filter((entry) => entry.uid !== uid),
      { uid, deletedAt: now },
    ];
    this.flush();
  }

  async recentlyDeleted(uid: string, since: number): Promise<boolean> {
    return this.data.deletedAccounts.some((entry) => entry.uid === uid && entry.deletedAt >= since);
  }

  /** Records that `shell agent` is polling, and what it publishes about itself. */
  async markAgentSeen(
    id: string,
    publicKey?: string,
    harnesses?: string[],
    now = Date.now(),
  ): Promise<void> {
    const token = this.data.tokens.find((entry) => entry.id === id);
    if (!token) return;
    token.agentSeenAt = now;
    if (publicKey) token.agentPublicKey = publicKey;
    /* An empty report is still a report, so this tests for absence only. */
    if (harnesses) token.harnesses = [...harnesses];
    this.flush();
  }

  /** Devices for one account, secrets stripped, newest first. */
  async listDevices(uid: string): Promise<Device[]> {
    return this.data.tokens
      .filter((entry) => entry.uid === uid && !entry.revokedAt)
      .sort(byTime<CliToken>((t) => t.createdAt, (t) => t.id, true))
      .map(({ id, label, createdAt, lastSeenAt, agentSeenAt, agentPublicKey, harnesses, revokedAt }) => ({
        id,
        label,
        createdAt,
        lastSeenAt,
        agentSeenAt,
        agentPublicKey,
        harnesses,
        revokedAt,
      }));
  }

  /* Scoped by uid so one account cannot revoke another account's machine. */
  async revokeDevice(uid: string, id: string, now = Date.now()): Promise<boolean> {
    const token = this.data.tokens.find(
      (entry) => entry.id === id && entry.uid === uid && !entry.revokedAt,
    );
    if (!token) return false;
    token.revokedAt = now;
    this.flush();
    return true;
  }

  /** Returns true when this session had not been seen before. */
  private invalidateContent(session: SessionRecord): void {
    const entry = this.data.sessionContent.find((item) => item.sessionUid === session.uid && item.sessionId === session.id);
    if (entry) {
      entry.generation = randomBytes(16).toString("hex");
      delete entry.content;
      delete entry.publishedAt;
    }
  }

  private contentState(session: SessionRecord) {
    let entry = this.data.sessionContent.find((item) => item.sessionUid === session.uid && item.sessionId === session.id);
    if (!entry) {
      entry = { sessionUid: session.uid, sessionId: session.id, generation: randomBytes(16).toString("hex") };
      this.data.sessionContent.push(entry);
      this.flush();
    }
    return entry;
  }

  async sessionContentPolicy(orgId: string, sessionId: string, ownerUid: string, deviceId: string): Promise<SessionContentPolicy | null> {
    const session = this.data.sessions.find((item) => item.id === sessionId && contentPublisher(item, orgId, ownerUid, deviceId));
    if (!session) return null;
    const state = this.contentState(session);
    return { enabled: session.dailyBriefingEnabled === true, ownerUid, generation: state.generation,
      nextPublishAt: state.publishedAt === undefined ? 0 : state.publishedAt + CONTENT_INTERVAL_MS };
  }

  async putSessionContent(orgId: string, sessionId: string, ownerUid: string, deviceId: string, content: SessionContent, now = Date.now()): Promise<ContentWriteResult> {
    const session = this.data.sessions.find((item) => item.id === sessionId && contentPublisher(item, orgId, ownerUid, deviceId));
    if (!session) return "missing";
    if (!session.dailyBriefingEnabled) return "disabled";
    const state = this.contentState(session);
    if (content.generation !== state.generation) return "stale";
    if (state.content && state.content.observedAt === content.observedAt && state.content.senderPublicKey === content.senderPublicKey && state.content.sealed === content.sealed) return "stored";
    if (state.publishedAt !== undefined && now < state.publishedAt + CONTENT_INTERVAL_MS) return "limited";
    state.content = { ...content };
    state.publishedAt = now;
    this.flush();
    return "stored";
  }

  async getSessionContent(orgId: string, sessionId: string, ownerUid: string): Promise<SessionContent | null> {
    const session = this.data.sessions.find((item) => item.id === sessionId && item.orgId === orgId && (item.ownerUid ?? item.uid) === ownerUid && item.dailyBriefingEnabled);
    if (!session) return null;
    const content = this.data.sessionContent.find((item) => item.sessionUid === session.uid && item.sessionId === session.id)?.content;
    return content ? { ...content } : null;
  }

  /* ---- MCP flow feed ---- */

  /*
   * Single-threaded, so the session check and the write cannot be interleaved
   * the way they can against a database. The check is still the same one the
   * SQL store makes under its row lock, because the contract is the same for
   * both stores and the conformance tests hold them to it.
   */
  async putMcpFlows(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    deviceId: string,
    events: McpFlowEvent[],
    now = Date.now(),
  ): Promise<boolean> {
    const session = this.data.sessions.find(
      (entry) =>
        entry.id === sessionId &&
        entry.orgId === orgId &&
        (entry.ownerUid ?? entry.uid) === ownerUid &&
        entry.closedAt === undefined,
    );
    if (!session || !contentPublisher(session, orgId, ownerUid, deviceId)) return false;
    const binding = mcpFlowBinding(session);
    for (const event of events) {
      /* A retry cannot replace metadata or move the expiry. */
      if (this.data.mcpFlows.some((row) => row.binding === binding && row.eventId === event.id && row.phase === event.phase)) continue;
      this.data.mcpFlows.push({
        ownerUid,
        orgId,
        binding,
        eventId: event.id,
        phase: event.phase,
        tool: event.tool,
        at: event.at,
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
        targetSessionId: session.id,
        expiresAt: mcpFlowExpiry(event.at, now),
      });
    }
    this.data.mcpFlows = trimMcpFlowRows(this.data.mcpFlows, now);
    this.flush();
    return true;
  }

  async listMcpFlows(orgId: string, ownerUid: string, activeDevices: Set<string>, now = Date.now()): Promise<McpFlow[]> {
    const allowed = mcpFlowAllowedBindings(this.data.sessions, orgId, ownerUid, activeDevices);
    const before = this.data.mcpFlows.length;
    /* Purge lost access so restoring it cannot resurrect these rows. */
    this.data.mcpFlows = this.data.mcpFlows.filter(
      (row) => row.orgId !== orgId || row.ownerUid !== ownerUid || allowed.has(row.binding),
    );
    this.data.mcpFlows = trimMcpFlowRows(this.data.mcpFlows, now);
    if (this.data.mcpFlows.length !== before) this.flush();
    return this.data.mcpFlows
      .filter((row) => row.orgId === orgId && row.ownerUid === ownerUid && allowed.has(row.binding) && row.expiresAt > now)
      .sort(byTime((row) => row.at, (row) => row.eventId))
      .slice(-MCP_FLOW_LIMIT)
      .map((row) => ({
        id: row.eventId,
        tool: row.tool,
        phase: row.phase,
        at: row.at,
        ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
        targetSessionId: row.targetSessionId,
      }));
  }

  async upsertSession(session: SessionRecord): Promise<boolean> {
    const index = this.data.sessions.findIndex(
      (entry) => entry.id === session.id && entry.uid === session.uid,
    );
    if (index >= 0) {
      const existing = this.data.sessions[index];
      if (existing.shareUrl !== session.shareUrl || existing.origin !== session.origin || existing.orgId !== session.orgId || existing.ownerUid !== session.ownerUid) this.invalidateContent(existing);
      const hadAssignment = existing.assigneeUids !== undefined;
      this.data.sessions[index] = {
        ...existing,
        ...session,
        // Match PostgreSQL: absent provenance on registration clears it.
        origin: session.origin,
        /*
         * A restart that names nothing keeps the name somebody gave it, in
         * the terminal or in the browser. Only a name it does send replaces it.
         */
        name: session.name ?? existing.name,
        /*
         * A persistent session re-registers on every restart, carrying the
         * owner as assignee. Letting that through would silently undo a
         * handoff, so an assignment already made stands.
         */
        assigneeUid: hadAssignment
          ? existing.assigneeUid
          : existing.assigneeUid ?? session.assigneeUid,
        assigneeUids:
          hadAssignment
            ? existing.assigneeUids
            : session.assigneeUids?.length
              ? session.assigneeUids
              : session.assigneeUid
                ? [session.assigneeUid]
                : [],
        /*
         * Consent is the owner's alone to give. A re-register carries no
         * opinion on it, and letting one through would flip a switch the
         * owner set on purpose, so the stored value stands either way.
         */
        mcpTeamAccess: existing.mcpTeamAccess ?? false,
        dailyBriefingEnabled: existing.dailyBriefingEnabled ?? false,
        dailyBriefingTeamAccess: existing.dailyBriefingTeamAccess ?? false,
      };
    } else {
      this.data.sessions.push({
        ...session,
        assigneeUids: session.assigneeUids ?? (session.assigneeUid ? [session.assigneeUid] : []),
        /* A session that has never been consented to starts with everything off. */
        mcpTeamAccess: false,
        /*
         * The one switch a new session may start with already set: the owner's
         * saved default, supplied by the store rather than trusted from the
         * registration. Everything else stays off until asked.
         */
        dailyBriefingEnabled: this.briefingDefaultFor(session),
        dailyBriefingTeamAccess: false,
      });
    }
    this.flush();
    return index < 0;
  }

  /*
   * The saved default for the owner of a session being inserted, read from
   * the membership row the store itself holds. A session outside an
   * organization, or one whose owner has no membership here, gets the
   * default every account has had: off.
   */
  private briefingDefaultFor(session: SessionRecord): boolean {
    if (!session.orgId) return false;
    const ownerUid = session.ownerUid ?? session.uid;
    return this.data.memberships.some(
      (entry) =>
        entry.orgId === session.orgId &&
        entry.uid === ownerUid &&
        entry.dailyBriefingDefault === true,
    );
  }

  async patchSession(uid: string, id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
    const session = this.data.sessions.find((entry) => entry.id === id && entry.uid === uid);
    if (!session) return null;
    if ((["dailyBriefingEnabled", "shareUrl", "origin", "ownerUid", "orgId"] as const).some((key) => key in patch && patch[key] !== session[key])) this.invalidateContent(session);
    Object.assign(session, patch);
    this.flush();
    return session;
  }

  /* Scoped by uid at the store boundary so a route cannot leak another account. */
  async listSessions(uid: string): Promise<SessionRecord[]> {
    return this.data.sessions
      .filter((entry) => entry.uid === uid)
      .sort(byTime((entry) => entry.startedAt, (entry) => entry.id, true));
  }

  /** Every session in an organization, which is what colleagues can see. */
  async listOrgSessions(orgId: string): Promise<SessionRecord[]> {
    return this.data.sessions
      .filter((entry) => entry.orgId === orgId)
      .sort(byTime((entry) => entry.startedAt, (entry) => entry.id, true));
  }

  async sessionInOrg(orgId: string, id: string): Promise<SessionRecord | null> {
    return this.data.sessions.find(
      (entry) => entry.id === id && entry.orgId === orgId,
    ) ?? null;
  }

  async assignSession(orgId: string, id: string, assigneeUids: string[]): Promise<SessionRecord | null> {
    const session = await this.sessionInOrg(orgId, id);
    if (!session) return null;
    session.assigneeUids = [...new Set(assigneeUids)];
    session.assigneeUid = session.assigneeUids[0];
    this.flush();
    return session;
  }

  async renameSession(orgId: string, id: string, name: string | undefined): Promise<SessionRecord | null> {
    const session = await this.sessionInOrg(orgId, id);
    if (!session) return null;
    if (name === undefined) delete session.name;
    else session.name = name;
    this.flush();
    return session;
  }

  async setSessionAutomationConsent(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    consent: Partial<SessionAutomationConsent>,
  ): Promise<SessionRecord | null> {
    const session = this.data.sessions.find(
      (entry) =>
        entry.id === sessionId &&
        entry.orgId === orgId &&
        (entry.ownerUid ?? entry.uid) === ownerUid,
    );
    if (!session) return null;
    if (consent.mcpTeamAccess !== undefined) session.mcpTeamAccess = consent.mcpTeamAccess;
    if (consent.dailyBriefingEnabled !== undefined) {
      if (!!session.dailyBriefingEnabled !== consent.dailyBriefingEnabled) this.invalidateContent(session);
      session.dailyBriefingEnabled = consent.dailyBriefingEnabled;
    }
    if (consent.dailyBriefingTeamAccess !== undefined) session.dailyBriefingTeamAccess = consent.dailyBriefingTeamAccess;
    this.flush();
    return session;
  }

  async dailyBriefingDefault(orgId: string, uid: string): Promise<boolean> {
    const membership = this.data.memberships.find(
      (entry) => entry.orgId === orgId && entry.uid === uid,
    );
    return membership?.dailyBriefingDefault === true;
  }

  async setDailyBriefingPreference(
    orgId: string,
    uid: string,
    enabled: boolean,
    applyToExisting: boolean,
  ): Promise<{ enabled: boolean; applied: number } | null> {
    const membership = this.data.memberships.find(
      (entry) => entry.orgId === orgId && entry.uid === uid,
    );
    if (!membership) return null;
    membership.dailyBriefingDefault = enabled;
    let applied = 0;
    if (applyToExisting) {
      /*
       * The owner's sessions in this organization only: a legacy row's uid
       * stands in for a missing owner, and a session somebody merely assigned
       * to this person is not theirs to switch. Nothing but the briefing
       * switch moves.
       */
      for (const session of this.data.sessions) {
        if (session.orgId === orgId && (session.ownerUid ?? session.uid) === uid) {
          if (!!session.dailyBriefingEnabled !== enabled) this.invalidateContent(session);
          session.dailyBriefingEnabled = enabled;
          applied += 1;
        }
      }
    }
    this.flush();
    return { enabled, applied };
  }

  async deleteSession(orgId: string, id: string): Promise<boolean> {
    const deleted = this.data.sessions.find((item) => item.orgId === orgId && item.id === id);
    if (deleted) this.data.sessionContent = this.data.sessionContent.filter((item) => item.sessionUid !== deleted.uid || item.sessionId !== id);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(
      (entry) => !(entry.id === id && entry.orgId === orgId),
    );
    /*
     * The audit trail outlives the session it describes. Removing a row is
     * itself an audited act, and a trail that vanished with its subject would
     * record nothing worth keeping.
     */
    if (this.data.sessions.length === before) return false;
    this.flush();
    return true;
  }

  async putCommand(command: AgentCommand): Promise<void> {
    this.data.commands.push(command);
    this.flush();
  }

  /*
   * Hands a machine everything queued for it and marks it claimed in the same
   * step, so two agents on one device cannot both run the same command.
   */
  async claimCommands(deviceId: string, now = Date.now()): Promise<AgentCommand[]> {
    const claimed = this.data.commands.filter(
      (entry) => entry.deviceId === deviceId && !entry.claimedAt,
    );
    if (claimed.length === 0) return [];
    for (const entry of claimed) entry.claimedAt = now;
    this.flush();
    return claimed;
  }

  async finishCommand(deviceId: string, id: string, error: string | undefined, now = Date.now()): Promise<boolean> {
    const entry = this.data.commands.find(
      (candidate) => candidate.id === id && candidate.deviceId === deviceId,
    );
    if (!entry || entry.doneAt) return false;
    entry.doneAt = now;
    if (error) entry.error = error;
    this.flush();
    return true;
  }

  async listCommands(uid: string, limit = 20): Promise<AgentCommand[]> {
    return this.data.commands
      .filter((entry) => entry.uid === uid)
      .sort(byTime((entry) => entry.createdAt, (entry) => entry.id, true))
      .slice(0, limit);
  }

  /* ---------------------------------------------------------------
     Organizations
     --------------------------------------------------------------- */

  async putOrganization(organization: Organization): Promise<void> {
    this.data.organizations.push(organization);
    this.flush();
  }

  async organization(orgId: string): Promise<Organization | null> {
    return this.data.organizations.find((entry) => entry.id === orgId) ?? null;
  }

  async renameOrganization(orgId: string, name: string): Promise<boolean> {
    const organization = await this.organization(orgId);
    if (!organization) return false;
    organization.name = name;
    this.flush();
    return true;
  }

  /*
   * Single-threaded, so "check then write" cannot be interleaved here the way
   * it can against a database. The check is still made, because the contract
   * is the same for both stores and the tests hold them to it.
   */
  async claimOwnOrganization(
    organization: Organization,
    membership: Membership,
  ): Promise<Membership> {
    const existing = this.data.memberships.find((entry) => entry.uid === membership.uid);
    if (existing) return existing;
    this.data.organizations.push(organization);
    this.data.memberships.push(membership);
    this.flush();
    return membership;
  }

  async putMembership(membership: Membership): Promise<void> {
    /*
     * Every row for this person goes, not just the one in this organization.
     * A person belongs to one organization -- membershipOf looks one up by
     * uid alone -- so leaving the old row behind would let a stale membership
     * win the lookup after someone moved.
     */
    const existing = this.data.memberships.find((entry) => entry.uid === membership.uid);
    this.data.memberships = this.data.memberships.filter(
      (entry) => entry.uid !== membership.uid,
    );
    /*
     * The saved briefing default is the account's, not this row's. A
     * re-login or a move between organizations rewrites the row, and letting
     * that reset a choice the person made would be a consent revoked without
     * being asked. A value the caller actually carries still stands. Absent
     * and an explicit null are the same "no opinion", the way the SQL store
     * reads them.
     */
    const incoming: boolean | null | undefined = membership.dailyBriefingDefault;
    const stored =
      (incoming === undefined || incoming === null) && existing?.dailyBriefingDefault !== undefined
        ? { ...membership, dailyBriefingDefault: existing.dailyBriefingDefault }
        : membership;
    this.data.memberships.push(stored);
    this.flush();
  }

  /** The single organization a person belongs to, or null before signup. */
  async membershipOf(uid: string): Promise<Membership | null> {
    return this.data.memberships.find((entry) => entry.uid === uid) ?? null;
  }

  async members(orgId: string): Promise<Membership[]> {
    return this.data.memberships
      .filter((entry) => entry.orgId === orgId)
      .sort(byTime((entry) => entry.joinedAt, (entry) => entry.uid))
      .map((entry) => {
        /* Each member's vault key rides along, so a password can be sealed to it. */
        const accountKey = this.data.accountKeys.find((key) => key.uid === entry.uid)?.publicKey;
        return accountKey ? { ...entry, accountKey } : entry;
      });
  }

  async removeMember(orgId: string, uid: string): Promise<boolean> {
    const before = this.data.memberships.length;
    this.data.memberships = this.data.memberships.filter(
      (entry) => !(entry.orgId === orgId && entry.uid === uid),
    );
    if (this.data.memberships.length === before) return false;
    for (const session of this.data.sessions) {
      if (session.orgId === orgId && session.keyShares) {
        session.keyShares = session.keyShares.filter((share) => share.uid !== uid);
      }
    }
    this.flush();
    return true;
  }

  async setRole(orgId: string, uid: string, role: Role): Promise<boolean> {
    const membership = this.data.memberships.find(
      (entry) => entry.orgId === orgId && entry.uid === uid,
    );
    if (!membership) return false;
    membership.role = role;
    this.flush();
    return true;
  }

  /* ---------------------------------------------------------------
     Invites
     --------------------------------------------------------------- */

  async putInvite(invite: Invite): Promise<void> {
    this.data.invites.push(invite);
    this.flush();
  }

  async invite(id: string): Promise<Invite | undefined> {
    return this.data.invites.find((entry) => entry.id === id);
  }

  async invites(orgId: string): Promise<Invite[]> {
    return this.data.invites
      .filter((entry) => entry.orgId === orgId)
      .sort(byTime((entry) => entry.createdAt, (entry) => entry.id, true));
  }

  async claimInvite(id: string, acceptedBy: string, now = Date.now()): Promise<Invite | undefined> {
    const invite = this.data.invites.find((entry) => entry.id === id);
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) return undefined;
    invite.acceptedAt = now;
    invite.acceptedBy = acceptedBy;
    this.flush();
    return invite;
  }

  async updateInvite(id: string, patch: Partial<Invite>): Promise<void> {
    const invite = this.data.invites.find((entry) => entry.id === id);
    if (!invite) return;
    Object.assign(invite, patch);
    this.flush();
  }

  /* ---------------------------------------------------------------
     Audit
     --------------------------------------------------------------- */

  async putAudit(event: AuditEvent): Promise<void> {
    this.data.audit.push(event);
    this.flush();
  }

  async plaintextAudit(orgId: string, limit: number): Promise<AuditEvent[]> {
    return this.data.audit
      .filter((entry) => entry.orgId === orgId && isTyped(entry) && !isSealed(entry.text))
      .sort(byTime((entry) => entry.at, (entry) => entry.id))
      .slice(0, limit);
  }

  async sealAudit(orgId: string, id: string, text: string, sealedBy: string): Promise<boolean> {
    const entry = this.data.audit.find((candidate) => candidate.orgId === orgId && candidate.id === id);
    if (!entry || !isTyped(entry) || isSealed(entry.text)) return false;
    entry.text = text;
    entry.sealedBy = sealedBy;
    this.flush();
    return true;
  }

  /* ---------------------------------------------------------------
     Team audit key
     --------------------------------------------------------------- */

  async gameProfile(uid: string): Promise<GameProfile | null> {
    const found = this.data.gameProfiles.find((entry) => entry.uid === uid);
    return found ? { ...found, owned: [...found.owned] } : null;
  }

  async putGameProfile(profile: GameProfile): Promise<void> {
    const stored = { ...profile, owned: [...profile.owned] };
    const at = this.data.gameProfiles.findIndex((entry) => entry.uid === profile.uid);
    if (at >= 0) this.data.gameProfiles[at] = stored;
    else this.data.gameProfiles.push(stored);
    await this.flush();
  }

  async recordCollectionRun(run: GameCollectionRun): Promise<void> {
    /*
     * The run's own id makes this idempotent. An agent that reports, loses the
     * reply and retries must not double somebody's bill -- and the bill is the
     * one number in this game that stands for real money.
     */
    if (this.data.collectionRuns.some((entry) => entry.id === run.id)) return;
    this.data.collectionRuns.push({ ...run });
    /*
     * The total and the rows move together, so the vial can never disagree
     * with the breakdown behind it. A profile that does not exist yet is made
     * here rather than refusing: the agent reporting is proof the account is
     * real, and losing the first run because nobody had opened the game would
     * be a hole in the account nobody could explain.
     */
    const at = this.data.gameProfiles.findIndex((entry) => entry.uid === run.uid);
    if (at >= 0) {
      this.data.gameProfiles[at] = {
        ...this.data.gameProfiles[at],
        tokens: this.data.gameProfiles[at].tokens + run.tokens,
        updatedAt: run.ranAt,
      };
    } else {
      this.data.gameProfiles.push({
        uid: run.uid,
        characterClass: "",
        skinId: "",
        liveryId: "",
        owned: [],
        spent: 0,
        gathering: true,
        tokens: run.tokens,
        createdAt: run.ranAt,
        updatedAt: run.ranAt,
      });
    }
    await this.flush();
  }

  async listCollectionRuns(uid: string, limit = 20): Promise<GameCollectionRun[]> {
    return this.data.collectionRuns
      .filter((run) => run.uid === uid)
      .sort((a, b) => b.ranAt - a.ranAt)
      .slice(0, limit)
      .map((run) => ({ ...run }));
  }

  async teamKey(orgId: string): Promise<TeamKey | null> {
    const found = this.data.teamKeys.find((entry) => entry.orgId === orgId);
    return found ? { ...found } : null;
  }

  async putTeamKey(key: TeamKey): Promise<boolean> {
    if (this.data.teamKeys.some((entry) => entry.orgId === key.orgId)) return false;
    this.data.teamKeys.push({ ...key });
    this.flush();
    return true;
  }

  async teamKeyShares(orgId: string): Promise<TeamKeyShare[]> {
    return this.data.teamKeyShares
      .filter((entry) => entry.orgId === orgId)
      .sort(byTime((entry) => entry.createdAt, (entry) => entry.uid))
      .map((entry) => ({ ...entry }));
  }

  async putTeamKeyShares(shares: TeamKeyShare[]): Promise<number> {
    let written = 0;
    for (const share of shares) {
      const exists = this.data.teamKeyShares.some(
        (entry) => entry.orgId === share.orgId && entry.uid === share.uid,
      );
      if (exists) continue;
      this.data.teamKeyShares.push({ ...share });
      written += 1;
    }
    if (written > 0) this.flush();
    return written;
  }

  async replaceOwnTeamKeyShare(share: TeamKeyShare): Promise<boolean> {
    const index = this.data.teamKeyShares.findIndex(
      (entry) => entry.orgId === share.orgId && entry.uid === share.uid && entry.version === share.version,
    );
    if (index < 0) return false;
    this.data.teamKeyShares[index] = { ...share };
    this.flush();
    return true;
  }

  async deleteTeamKeyShare(orgId: string, uid: string): Promise<boolean> {
    const before = this.data.teamKeyShares.length;
    this.data.teamKeyShares = this.data.teamKeyShares.filter(
      (entry) => !(entry.orgId === orgId && entry.uid === uid),
    );
    if (this.data.teamKeyShares.length === before) return false;
    this.flush();
    return true;
  }

  async auditFor(orgId: string, sessionId: string): Promise<AuditEvent[]> {
    return this.data.audit
      .filter((entry) => entry.orgId === orgId && entry.sessionId === sessionId)
      .sort(byTime((entry) => entry.at, (entry) => entry.id));
  }

  async auditForOrg(orgId: string, limit = 2000): Promise<AuditEvent[]> {
    return this.data.audit
      .filter((entry) => entry.orgId === orgId)
      .sort(byTime((entry) => entry.at, (entry) => entry.id))
      .slice(-limit);
  }

  async auditPage(orgId: string, query: AuditPageQuery): Promise<AuditPage> {
    const needle = query.query?.trim().toLocaleLowerCase();
    const matching = this.data.audit.filter((entry) => {
      if (entry.orgId !== orgId) return false;
      if (query.sessionId && entry.sessionId !== query.sessionId) return false;
      if (query.actorUid && entry.actorUid !== query.actorUid) return false;
      if (query.kind && entry.kind !== query.kind) return false;
      if (query.sinceAt && entry.at < query.sinceAt) return false;
      if (needle && !entry.text.toLocaleLowerCase().includes(needle)) return false;
      return true;
    });
    const newest = matching.sort(byTime((entry) => entry.at, (entry) => entry.id, true));
    return {
      events: newest.slice(query.offset, query.offset + query.limit),
      total: newest.length,
    };
  }

  /* ---------------------------------------------------------------
     Comments and notifications
     --------------------------------------------------------------- */

  async putComment(comment: Comment): Promise<void> {
    this.data.comments.push(comment);
    this.flush();
  }

  async comments(orgId: string, sessionId: string): Promise<Comment[]> {
    return this.data.comments
      .filter((entry) => entry.orgId === orgId && entry.sessionId === sessionId)
      .sort(byTime((entry) => entry.at, (entry) => entry.id));
  }

  async putNotification(notification: Notification): Promise<void> {
    this.data.notifications.push(notification);
    this.flush();
  }

  async notificationsFor(orgId: string, uid: string, limit = 100): Promise<Notification[]> {
    return this.data.notifications
      .filter((entry) => entry.orgId === orgId && entry.uid === uid)
      .sort(byTime((entry) => entry.at, (entry) => entry.id, true))
      .slice(0, limit);
  }

  async markNotificationRead(orgId: string, uid: string, id: string, now = Date.now()): Promise<boolean> {
    const notification = this.data.notifications.find(
      (entry) => entry.orgId === orgId && entry.id === id && entry.uid === uid,
    );
    if (!notification || notification.readAt) return false;
    notification.readAt = now;
    this.flush();
    return true;
  }

  async markAllNotificationsRead(orgId: string, uid: string, now = Date.now()): Promise<number> {
    let count = 0;
    for (const notification of this.data.notifications) {
      if (notification.orgId === orgId && notification.uid === uid && !notification.readAt) {
        notification.readAt = now;
        count += 1;
      }
    }
    if (count > 0) this.flush();
    return count;
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    this.data.accountActivity = this.data.accountActivity.filter(
      (entry) => entry.day >= now - ACCOUNT_ACTIVITY_MEMORY_MS,
    );
    this.data.appEvents = this.data.appEvents.filter(
      (entry) => entry.day >= now - ACCOUNT_ACTIVITY_MEMORY_MS,
    );
    const before = this.data.codes.length;
    this.data.codes = this.data.codes.filter((entry) => entry.expiresAt > now);
    /* Finished commands are only kept long enough to be reported back. */
    const commandsBefore = this.data.commands.length;
    this.data.commands = this.data.commands.filter(
      (entry) => !entry.doneAt || now - entry.doneAt < 10 * 60_000,
    );
    const deletedBefore = this.data.deletedAccounts.length;
    this.data.deletedAccounts = this.data.deletedAccounts.filter(
      (entry) => now - entry.deletedAt < DELETED_ACCOUNT_MEMORY_MS,
    );
    /* Flow rows are a live feed: the purge is what keeps the table a feed. */
    const flowsBefore = this.data.mcpFlows.length;
    this.data.mcpFlows = trimMcpFlowRows(this.data.mcpFlows, now);
    if (
      this.data.codes.length !== before ||
      this.data.commands.length !== commandsBefore ||
      this.data.deletedAccounts.length !== deletedBefore ||
      this.data.mcpFlows.length !== flowsBefore
    ) {
      this.flush();
    }
  }

  /* ---------------------------------------------------------------
     Import helpers

     Deliberately not on the Store interface. Every read there is scoped to an
     account or an organization so a route cannot forget to scope it; these
     return everything, which is exactly what a one-off copy into a database
     needs and what nothing serving a request should have.
     --------------------------------------------------------------- */

  async organizationsForImport(): Promise<Organization[]> {
    return this.data.organizations;
  }

  /* ---- Feedback ---- */

  async putFeedback(feedback: Feedback): Promise<void> {
    this.data.feedback.push(feedback);
    this.flush();
  }

  async feedback(limit = 100): Promise<Feedback[]> {
    return [...this.data.feedback]
      .sort(byTime((entry) => entry.at, (entry) => entry.id, true))
      .slice(0, limit);
  }

  /* ---- Account activity ---- */

  async touchMembership(uid: string, now = Date.now(), resolutionMs = 60 * 60_000): Promise<void> {
    const membership = this.data.memberships.find((entry) => entry.uid === uid);
    if (!membership) return;
    if (membership.lastSeenAt !== undefined && now - membership.lastSeenAt < resolutionMs) return;
    membership.lastSeenAt = now;
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    if (!this.data.accountActivity.some((entry) => entry.uid === uid && entry.day === day)) {
      this.data.accountActivity.push({ uid, day });
    }
    this.flush();
  }

  async accountActivity(isInternal: (email: string) => boolean = () => false): Promise<AccountActivity[]> {
    return this.data.memberships.map((membership) => ({
      joinedAt: membership.joinedAt,
      days: this.data.accountActivity
        .filter((entry) => entry.uid === membership.uid)
        .map((entry) => entry.day)
        .sort((left, right) => left - right),
      internal: isInternal(membership.email),
    }));
  }

  /* ---- App events ---- */

  async recordAppEvent(event: AppEvent, now = Date.now(), internal = false): Promise<void> {
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    const row = this.data.appEvents.find(
      (entry) => entry.event === event && entry.day === day && (entry.internal ?? false) === internal,
    );
    if (row) row.count += 1;
    else this.data.appEvents.push({ event, day, count: 1, internal });
    this.flush();
  }

  async appEvents(sinceDay: number): Promise<AppEventCount[]> {
    const totals = new Map<AppEvent, number>();
    for (const entry of this.data.appEvents) {
      if (entry.internal ?? false) continue;
      if (entry.day >= sinceDay) totals.set(entry.event, (totals.get(entry.event) ?? 0) + entry.count);
    }
    return [...totals.entries()]
      .map(([event, count]) => ({ event, count }))
      .sort((left, right) => left.event.localeCompare(right.event));
  }

  async tokensForImport(): Promise<CliToken[]> {
    return this.data.tokens;
  }

  async sessionsForImport(): Promise<SessionRecord[]> {
    return this.data.sessions;
  }

  async commentsForImport(): Promise<Comment[]> {
    return this.data.comments;
  }

  async notificationsForImport(): Promise<Notification[]> {
    return this.data.notifications;
  }

  /* Nothing to release; the interface asks so a database can be closed. */
  async close(): Promise<void> {}
}
