import type { Invite, Membership, Organization, Role } from "./orgs";
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
} from "./types";

export * from "./types";

export interface AuditPageQuery {
  limit: number;
  offset: number;
  sessionId?: string;
  actorUid?: string;
  kind?: AuditEvent["kind"];
  query?: string;
  sinceAt?: number;
}

export interface AuditPage {
  events: AuditEvent[];
  total: number;
}

/**
 * How long a deleted account's uid is remembered. A Firebase ID token lives an
 * hour; the second hour is slack for clock skew and for a token minted just
 * before the deletion.
 */
export const DELETED_ACCOUNT_MEMORY_MS = 2 * 60 * 60_000;

/** What the activity trail shows in place of a deleted account's email. */
export const DELETED_ACTOR_EMAIL = "deleted account";

/** What deleting an account does to the organization it belonged to. */
export interface AccountDeletion {
  orgId?: string;
  /** Delete the organization and everything in it, because nobody else is in it. */
  dissolve: boolean;
  /** The member who becomes owner, when the owner is the one leaving. */
  successorUid?: string;
}

/**
 * Everything the service keeps.
 *
 * Every method is asynchronous because the real implementation talks to a
 * database. The in-memory one satisfies the same shape, so the route tests
 * exercise the code paths that run in production rather than a sync variant
 * of them.
 *
 * Reads that belong to one account or one organization take that scope as an
 * argument rather than filtering afterwards, so a route cannot forget to.
 */
export interface Store {
  /* ---- CLI login ---- */
  putCode(code: AuthorizationCode): Promise<void>;
  takeCode(
    code: string,
    now?: number,
  ): Promise<{ entry: AuthorizationCode; alreadyConsumed: boolean } | null>;
  putToken(token: CliToken): Promise<void>;
  findByAccessHash(hash: string): Promise<CliToken | null>;
  findByRefreshHash(hash: string): Promise<CliToken | null>;
  updateToken(refreshHash: string, patch: Partial<CliToken>): Promise<void>;
  touchToken(id: string, now?: number, resolutionMs?: number): Promise<void>;

  /* ---- Machines ---- */
  /**
   * The live device this account has for a machine, if any. Scoped by uid, so
   * a machine id learned elsewhere can never select another account's device.
   */
  deviceForMachine(uid: string, machineId: string): Promise<CliToken | null>;
  /**
   * The machine a device belonged to, including a device that has been
   * revoked.
   *
   * Unlinking a machine revokes its device row and signing in again makes a
   * new one, deliberately, so that unlinking survives the next login. A
   * session started before that still names the old row, and the only way
   * back to the machine still running it is the machine id they share.
   */
  machineForDevice(uid: string, deviceId: string): Promise<string | null>;
  setMemberKey(uid: string, publicKey: string): Promise<void>;
  /**
   * Records a poll. `harnesses` left undefined keeps whatever the machine
   * reported last, so an older CLI that does not send them does not erase
   * them; an empty array is a report of none and does replace it.
   */
  markAgentSeen(
    id: string,
    publicKey?: string,
    harnesses?: string[],
    now?: number,
  ): Promise<void>;
  listDevices(uid: string): Promise<Device[]>;
  revokeDevice(uid: string, id: string, now?: number): Promise<boolean>;

  /* ---- Sessions ---- */
  upsertSession(session: SessionRecord): Promise<boolean>;
  patchSession(uid: string, id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null>;
  listSessions(uid: string): Promise<SessionRecord[]>;
  listOrgSessions(orgId: string): Promise<SessionRecord[]>;
  sessionInOrg(orgId: string, id: string): Promise<SessionRecord | null>;
  assignSession(orgId: string, id: string, assigneeUids: string[]): Promise<SessionRecord | null>;
  /**
   * Removes a session's record from an organization.
   *
   * The row only. Whatever the session left on the machine that ran it is not
   * ours to touch, and the process is already gone by the time anyone can ask
   * for this.
   */
  deleteSession(orgId: string, id: string): Promise<boolean>;
  putKeyShares(orgId: string, sessionId: string, shares: SessionKeyShare[]): Promise<boolean>;

  /* ---- Session vault ---- */
  accountKey(uid: string): Promise<AccountKey | null>;
  /**
   * Writes a vault. Without `expectedVersion` it only creates one, and fails
   * if one exists; with it, it replaces only the vault at that version. False
   * means the condition failed, so two browsers setting up at once cannot both
   * believe they won, and a reset cannot overwrite a reset it has not seen.
   */
  putAccountKey(key: AccountKey, expectedVersion?: number): Promise<boolean>;

  /* ---- Account deletion ---- */
  /**
   * Removes what this service holds for one person, in one step.
   *
   * Their machines' tokens, their sessions and the passwords sealed to them,
   * their vault, comments, notifications and membership. What they typed into
   * colleagues' sessions stays in the team's trail, since it is the record of
   * what happened on those machines, but no longer carries their email. The
   * plan says what happens to the organization: dissolved when nobody else is
   * in it, handed to `successorUid` when its owner is the one leaving.
   *
   * The uid is then remembered for DELETED_ACCOUNT_MEMORY_MS.
   */
  deleteAccount(uid: string, plan: AccountDeletion, now?: number): Promise<void>;
  /** Whether this uid was deleted at or after `since`. */
  recentlyDeleted(uid: string, since: number): Promise<boolean>;

  /* ---- Agent commands ---- */
  putCommand(command: AgentCommand): Promise<void>;
  claimCommands(deviceId: string, now?: number): Promise<AgentCommand[]>;
  finishCommand(deviceId: string, id: string, error: string | undefined, now?: number): Promise<boolean>;
  listCommands(uid: string, limit?: number): Promise<AgentCommand[]>;

  /* ---- Organizations ---- */
  putOrganization(organization: Organization): Promise<void>;
  organization(orgId: string): Promise<Organization | null>;
  renameOrganization(orgId: string, name: string): Promise<boolean>;
  putMembership(membership: Membership): Promise<void>;
  /**
   * Creates an organization and its first membership together, unless this
   * person already has one.
   *
   * Returns whichever membership stands afterwards, which may be one another
   * request wrote. Signing in fires several requests at once and none of them
   * finds a membership, so without this they each create an organization and
   * race to claim the same person.
   */
  claimOwnOrganization(organization: Organization, membership: Membership): Promise<Membership>;
  membershipOf(uid: string): Promise<Membership | null>;
  members(orgId: string): Promise<Membership[]>;
  removeMember(orgId: string, uid: string): Promise<boolean>;
  setRole(orgId: string, uid: string, role: Role): Promise<boolean>;

  /* ---- Invites ---- */
  putInvite(invite: Invite): Promise<void>;
  invite(id: string): Promise<Invite | undefined>;
  invites(orgId: string): Promise<Invite[]>;
  /** Atomically consumes a live, unused invite. Exactly one caller can win. */
  claimInvite(id: string, acceptedBy: string, now?: number): Promise<Invite | undefined>;
  updateInvite(id: string, patch: Partial<Invite>): Promise<void>;

  /* ---- Audit ---- */
  putAudit(event: AuditEvent): Promise<void>;
  auditFor(orgId: string, sessionId: string): Promise<AuditEvent[]>;
  auditForOrg(orgId: string, limit?: number): Promise<AuditEvent[]>;
  auditPage(orgId: string, query: AuditPageQuery): Promise<AuditPage>;

  /* ---- Comments and notifications ---- */
  putComment(comment: Comment): Promise<void>;
  comments(orgId: string, sessionId: string): Promise<Comment[]>;
  putNotification(notification: Notification): Promise<void>;
  notificationsFor(uid: string, limit?: number): Promise<Notification[]>;
  markNotificationRead(uid: string, id: string, now?: number): Promise<boolean>;
  markAllNotificationsRead(uid: string, now?: number): Promise<number>;

  /* ---- Housekeeping ---- */
  purgeExpired(now?: number): Promise<void>;
  close(): Promise<void>;
}
