import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Invite, Membership, Organization, Role } from "./orgs";
import type { Store } from "./store";
import type {
  AgentCommand,
  AuditEvent,
  AuthorizationCode,
  CliToken,
  Comment,
  Device,
  Notification,
  SessionKeyShare,
  SessionRecord,
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

interface Shape {
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
}

const EMPTY: Shape = {
  codes: [], tokens: [], sessions: [], commands: [],
  organizations: [], memberships: [], invites: [], audit: [],
  comments: [], notifications: [],
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
        commands: parsed.commands ?? [],
        organizations: parsed.organizations ?? [],
        memberships: parsed.memberships ?? [],
        invites: parsed.invites ?? [],
        audit: parsed.audit ?? [],
        comments: parsed.comments ?? [],
        notifications: parsed.notifications ?? [],
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
  async upsertSession(session: SessionRecord): Promise<boolean> {
    const index = this.data.sessions.findIndex(
      (entry) => entry.id === session.id && entry.uid === session.uid,
    );
    if (index >= 0) {
      const existing = this.data.sessions[index];
      this.data.sessions[index] = {
        ...existing,
        ...session,
        /*
         * A persistent session re-registers on every restart, carrying the
         * owner as assignee. Letting that through would silently undo a
         * handoff, so an assignment already made stands.
         */
        assigneeUid: existing.assigneeUid ?? session.assigneeUid,
      };
    } else {
      this.data.sessions.push(session);
    }
    this.flush();
    return index < 0;
  }

  async patchSession(uid: string, id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
    const session = this.data.sessions.find((entry) => entry.id === id && entry.uid === uid);
    if (!session) return null;
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

  async assignSession(orgId: string, id: string, assigneeUid: string): Promise<SessionRecord | null> {
    const session = await this.sessionInOrg(orgId, id);
    if (!session) return null;
    session.assigneeUid = assigneeUid;
    this.flush();
    return session;
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
    this.data.memberships = this.data.memberships.filter(
      (entry) => entry.uid !== membership.uid,
    );
    this.data.memberships.push(membership);
    this.flush();
  }

  /** The single organization a person belongs to, or null before signup. */
  async membershipOf(uid: string): Promise<Membership | null> {
    return this.data.memberships.find((entry) => entry.uid === uid) ?? null;
  }

  async members(orgId: string): Promise<Membership[]> {
    return this.data.memberships
      .filter((entry) => entry.orgId === orgId)
      .sort(byTime((entry) => entry.joinedAt, (entry) => entry.uid));
  }

  async removeMember(orgId: string, uid: string): Promise<boolean> {
    const before = this.data.memberships.length;
    this.data.memberships = this.data.memberships.filter(
      (entry) => !(entry.orgId === orgId && entry.uid === uid),
    );
    if (this.data.memberships.length === before) return false;
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

  async notificationsFor(uid: string, limit = 100): Promise<Notification[]> {
    return this.data.notifications
      .filter((entry) => entry.uid === uid)
      .sort(byTime((entry) => entry.at, (entry) => entry.id, true))
      .slice(0, limit);
  }

  async markNotificationRead(uid: string, id: string, now = Date.now()): Promise<boolean> {
    const notification = this.data.notifications.find(
      (entry) => entry.id === id && entry.uid === uid,
    );
    if (!notification || notification.readAt) return false;
    notification.readAt = now;
    this.flush();
    return true;
  }

  async markAllNotificationsRead(uid: string, now = Date.now()): Promise<number> {
    let count = 0;
    for (const notification of this.data.notifications) {
      if (notification.uid === uid && !notification.readAt) {
        notification.readAt = now;
        count += 1;
      }
    }
    if (count > 0) this.flush();
    return count;
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    const before = this.data.codes.length;
    this.data.codes = this.data.codes.filter((entry) => entry.expiresAt > now);
    /* Finished commands are only kept long enough to be reported back. */
    const commandsBefore = this.data.commands.length;
    this.data.commands = this.data.commands.filter(
      (entry) => !entry.doneAt || now - entry.doneAt < 10 * 60_000,
    );
    if (this.data.codes.length !== before || this.data.commands.length !== commandsBefore) {
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
