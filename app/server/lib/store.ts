import type { Invite, Membership, Organization, Role } from "./orgs";
import type { ContentWriteResult, SessionContent, SessionContentPolicy } from "./session-content";
import type { McpFlow, McpFlowEvent } from "./mcp-flows";
import type {
  AccountActivity,
  AppEvent,
  AppEventCount,
  AccountKey,
  AgentCommand,
  GameCollectionRun,
  AuditEvent,
  AuthorizationCode,
  CliToken,
  Comment,
  Device,
  Feedback,
  GameProfile,
  Notification,
  SessionAutomationConsent,
  SessionKeyShare,
  SessionRecord,
  TeamKey,
  TeamKeyShare,
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

export const DAY_MS = 24 * 60 * 60_000;

/**
 * How long the days an account used the app are kept. Long enough for a
 * year's sign-up cohorts to be read back, short enough that the table stays
 * a footnote.
 */
export const ACCOUNT_ACTIVITY_MEMORY_MS = 400 * DAY_MS;

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
  sessionContentPolicy(orgId: string, sessionId: string, ownerUid: string, deviceId: string): Promise<SessionContentPolicy | null>;
  putSessionContent(orgId: string, sessionId: string, ownerUid: string, deviceId: string, content: SessionContent, now?: number): Promise<ContentWriteResult>;
  getSessionContent(orgId: string, sessionId: string, ownerUid: string): Promise<SessionContent | null>;

  /* ---- MCP flow feed ---- */
  /**
   * Records flow metadata reported by a session's own device, as one step.
   *
   * The session row is the bound: it is read as the owner's open session in
   * the organization and must still be published by this device, or nothing
   * is written. A report that loses a race with the session closing, being
   * deleted, or changing provenance writes nothing rather than a row that
   * outlives the session it describes.
   *
   * A row that already exists for the same provenance, event id and phase is
   * left exactly as it was: a retry neither replaces the metadata nor moves
   * the expiry. Rows are short-lived by construction (MCP_FLOW_TTL): a row is
   * unservable the instant it passes its expiry, and the physical delete is
   * opportunistic, on the operations around it rather than at an exact moment.
   * The write keeps the owner's share of the table at most MCP_FLOW_LIMIT
   * rows and the table at most MCP_FLOW_GLOBAL_LIMIT rows, serialized against
   * every other flow report, not just the owner's own.
   */
  putMcpFlows(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    deviceId: string,
    events: McpFlowEvent[],
    now?: number,
  ): Promise<boolean>;
  /**
   * The owner's live flow feed, rechecked against the sessions as they are
   * now: only an open session in the organization that the owner still owns
   * and whose originating device is still active serves its rows.
   *
   * Rows whose session lost any of that are deleted on the way, so restoring
   * the session later cannot resurrect a feed it should have lost. Bounded to
   * the MCP_FLOW_LIMIT most recent rows, oldest first.
   */
  listMcpFlows(orgId: string, ownerUid: string, activeDevices: Set<string>, now?: number): Promise<McpFlow[]>;
  upsertSession(session: SessionRecord): Promise<boolean>;
  patchSession(uid: string, id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null>;
  listSessions(uid: string): Promise<SessionRecord[]>;
  listOrgSessions(orgId: string): Promise<SessionRecord[]>;
  sessionInOrg(orgId: string, id: string): Promise<SessionRecord | null>;
  assignSession(orgId: string, id: string, assigneeUids: string[]): Promise<SessionRecord | null>;
  /** Sets the label a session is shown by. Undefined clears it, so the command shows instead. */
  renameSession(orgId: string, id: string, name: string | undefined): Promise<SessionRecord | null>;
  /**
   * Patches a session's automation consent as one owner-scoped update.
   * Omitted switches are preserved atomically, not filled from an earlier read.
   *
   * The row is addressed by organization and id, and is only updated when the
   * caller is the row's owner (a legacy row's uid stands in for a missing
   * owner), so a foreign organization or a caller who does not own the row
   * cannot move a switch. Returns the updated session, or null when no row in
   * that organization is owned by that uid.
   */
  setSessionAutomationConsent(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    consent: Partial<SessionAutomationConsent>,
  ): Promise<SessionRecord | null>;
  /**
   * The saved daily-briefing default for one membership, keyed by the
   * organization and the uid that membership row belongs to. Absent reads as
   * false, which is the consent every account gave before the column existed.
   */
  dailyBriefingDefault(orgId: string, uid: string): Promise<boolean>;
  /**
   * Saves an owner's daily-briefing default and, when asked, applies it to
   * every session that owner has in the organization, in one step.
   *
   * The principal is the membership row itself: both statements address
   * (org_id, uid) as given, so a caller cannot name somebody else's default
   * or another organization's sessions. The session update matches
   * COALESCE(owner_uid, uid), so a legacy row whose owner column is empty is
   * addressed by its uid, and a session the owner merely has assigned to
   * them is not theirs to switch. No other consent field is touched.
   *
   * Returns the saved default and how many sessions were updated, or null
   * when no such membership exists.
   */
  setDailyBriefingPreference(
    orgId: string,
    uid: string,
    enabled: boolean,
    applyToExisting: boolean,
  ): Promise<{ enabled: boolean; applied: number } | null>;
  /**
   * Removes a session's record from an organization.
   *
   * The row only. Whatever the session left on the machine that ran it is not
   * ours to touch, and the process is already gone by the time anyone can ask
   * for this.
   */
  deleteSession(orgId: string, id: string): Promise<boolean>;
  putKeyShares(orgId: string, sessionId: string, shares: SessionKeyShare[]): Promise<boolean>;
  /** Changes the public salt and every sealed copy as one credential generation. */
  rotateSessionCredentials(
    orgId: string,
    sessionId: string,
    ownerUid: string,
    shareUrl: string,
    shares: SessionKeyShare[],
  ): Promise<SessionRecord | null>;

  /* ---- Session vault ---- */
  accountKey(uid: string): Promise<AccountKey | null>;
  /**
   * Writes a vault. Without `expectedVersion` it only creates one, and fails
   * if one exists; with it, it replaces only the vault at that version. False
   * means the condition failed, so two browsers setting up at once cannot both
   * believe they won, and a reset cannot overwrite a reset it has not seen.
   */
  putAccountKey(key: AccountKey, expectedVersion?: number): Promise<boolean>;
  /** Replaces only the encrypted unlock methods; the account key and version stay stable. */
  updateAccountKeyWrap(uid: string, expectedVersion: number, recoveryWrap: string, updatedAt: number): Promise<boolean>;

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

  /* ---- The saved game ---- */
  /**
   * One account's saved game, or nothing if they have never opened it.
   *
   * Scoped by uid rather than by organization: the keep is a person's own
   * progress, and two people on the same team have their own.
   */
  gameProfile(uid: string): Promise<GameProfile | null>;
  /** Writes the whole profile. Creates it on first save. */
  putGameProfile(profile: GameProfile): Promise<void>;
  /**
   * Records one gathering run, and adds what it cost to the account's total.
   *
   * One call rather than two, because the total in the profile is the sum of
   * these rows: a writer that could record a run without adding its cost, or
   * add a cost without recording the run, is a writer that can make the vial
   * disagree with the breakdown behind it.
   */
  recordCollectionRun(run: GameCollectionRun): Promise<void>;
  /** The most recent runs, newest first, for the breakdown behind the vial. */
  listCollectionRuns(uid: string, limit?: number): Promise<GameCollectionRun[]>;

  /* ---- Team audit key ---- */
  teamKey(orgId: string): Promise<TeamKey | null>;
  /** Creates the team's audit key, and only if it has none. False when one exists. */
  putTeamKey(key: TeamKey): Promise<boolean>;
  teamKeyShares(orgId: string): Promise<TeamKeyShare[]>;
  /**
   * Stores members' copies of the team key. Insert-only: a copy that exists is
   * never overwritten, so nobody can replace a teammate's working copy with
   * one that does not open. Returns how many were written.
   */
  putTeamKeyShares(shares: TeamKeyShare[]): Promise<number>;
  deleteTeamKeyShare(orgId: string, uid: string): Promise<boolean>;
  /**
   * Replaces one member's own copy of the current key with one they sealed to
   * themselves. Only an existing copy of the same version is replaced, so it
   * cannot be used to take a copy nobody gave them. False when there is none.
   */
  replaceOwnTeamKeyShare(share: TeamKeyShare): Promise<boolean>;
  /** Typed input still stored as plaintext, oldest first, for a team member to seal. */
  plaintextAudit(orgId: string, limit: number): Promise<AuditEvent[]>;
  /**
   * Replaces a plaintext input entry with its sealed form, recording who did
   * it. Only an entry of a typed kind that is still plaintext can change, so
   * sealing cannot be used to rewrite an entry that is already sealed or one
   * the service wrote, and a re-sealed entry never passes for first-hand.
   */
  sealAudit(orgId: string, id: string, text: string, sealedBy: string): Promise<boolean>;

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
  notificationsFor(orgId: string, uid: string, limit?: number): Promise<Notification[]>;
  markNotificationRead(orgId: string, uid: string, id: string, now?: number): Promise<boolean>;
  markAllNotificationsRead(orgId: string, uid: string, now?: number): Promise<number>;

  /* ---- Feedback ---- */
  putFeedback(feedback: Feedback): Promise<void>;
  /**
   * Newest first. For an operator's export and for tests; the app never lists
   * it. Deleting an account keeps its messages and clears who sent them.
   */
  feedback(limit?: number): Promise<Feedback[]>;

  /* ---- Account activity ---- */
  /**
   * Records that an account used the app. Cheap enough for every request: the
   * membership's lastSeenAt moves at most once per `resolutionMs`, and the
   * day is written only when it does.
   */
  touchMembership(uid: string, now?: number, resolutionMs?: number): Promise<void>;
  /**
   * Every account's sign-up time and active days, with no identifiers.
   *
   * `isInternal` is applied to each address while the store still holds it,
   * and only its answer leaves: the caller can drop our own accounts from the
   * figures without ever being handed an address to drop them by.
   */
  accountActivity(isInternal?: (email: string) => boolean): Promise<AccountActivity[]>;

  /* ---- App events ---- */
  /**
   * Counts one thing an account did, on the day it did it. Nothing about who,
   * beyond whether the account was one of ours: counts of what the team did
   * while testing are kept apart from counts of what customers did, because
   * the dashboard reports the second and not the first.
   */
  recordAppEvent(event: AppEvent, now?: number, internal?: boolean): Promise<void>;
  /**
   * Customers' totals per kind over days on or after `sinceDay` (midnight
   * UTC), for the dashboard. Our own are never included.
   */
  appEvents(sinceDay: number): Promise<AppEventCount[]>;

  /* ---- Housekeeping ---- */
  purgeExpired(now?: number): Promise<void>;
  close(): Promise<void>;
}
