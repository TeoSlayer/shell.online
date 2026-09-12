import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
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
  accountKeys: AccountKey[];
  deletedAccounts: { uid: string; deletedAt: number }[];
  teamKeys: TeamKey[];
  teamKeyShares: TeamKeyShare[];
}

const EMPTY: Shape = {
  codes: [], tokens: [], sessions: [], commands: [],
  organizations: [], memberships: [], invites: [], audit: [],
  comments: [], notifications: [], accountKeys: [], deletedAccounts: [],
  teamKeys: [], teamKeyShares: [],
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
        accountKeys: parsed.accountKeys ?? [],
        deletedAccounts: parsed.deletedAccounts ?? [],
        teamKeys: parsed.teamKeys ?? [],
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
    for (const session of data.sessions) {
      if (session.keyShares) {
        session.keyShares = session.keyShares.filter((share) => share.uid !== uid);
      }
      const assignees = session.assigneeUids ?? [];
      if (assignees.includes(uid) || session.assigneeUid === uid) {
        session.assigneeUids = assignees.filter((entry) => entry !== uid);
        if (session.assigneeUid === uid) session.assigneeUid = session.assigneeUids[0];
      }
      if (session.ownerUid === uid) session.ownerUid = session.uid;
    }
    for (const invite of data.invites) {
      /* The address an invite was sent to is theirs once they accepted it. */
      if (invite.acceptedBy === uid) delete invite.email;
    }
    data.accountKeys = data.accountKeys.filter((entry) => entry.uid !== uid);
    data.comments = data.comments.filter((entry) => entry.authorUid !== uid);
    data.notifications = data.notifications.filter(
      (entry) => entry.uid !== uid && entry.actorUid !== uid,
    );
    for (const event of data.audit) {
      if (event.actorUid === uid) event.actorEmail = DELETED_ACTOR_EMAIL;
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
  async upsertSession(session: SessionRecord): Promise<boolean> {
    const index = this.data.sessions.findIndex(
      (entry) => entry.id === session.id && entry.uid === session.uid,
    );
    if (index >= 0) {
      const existing = this.data.sessions[index];
      const hadAssignment = existing.assigneeUids !== undefined;
      this.data.sessions[index] = {
        ...existing,
        ...session,
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
      };
    } else {
      this.data.sessions.push({
        ...session,
        assigneeUids: session.assigneeUids ?? (session.assigneeUid ? [session.assigneeUid] : []),
      });
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

  async assignSession(orgId: string, id: string, assigneeUids: string[]): Promise<SessionRecord | null> {
    const session = await this.sessionInOrg(orgId, id);
    if (!session) return null;
    session.assigneeUids = [...new Set(assigneeUids)];
    session.assigneeUid = session.assigneeUids[0];
    this.flush();
    return session;
  }

  async deleteSession(orgId: string, id: string): Promise<boolean> {
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
    if (
      this.data.codes.length !== before ||
      this.data.commands.length !== commandsBefore ||
      this.data.deletedAccounts.length !== deletedBefore
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
