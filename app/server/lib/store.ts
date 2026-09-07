import type { Invite, Membership, Organization, Role } from "./orgs";
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

export * from "./types";

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
  setMemberKey(uid: string, publicKey: string): Promise<void>;
  markAgentSeen(id: string, publicKey?: string, now?: number): Promise<void>;
  listDevices(uid: string): Promise<Device[]>;
  revokeDevice(uid: string, id: string, now?: number): Promise<boolean>;

  /* ---- Sessions ---- */
  upsertSession(session: SessionRecord): Promise<boolean>;
  patchSession(uid: string, id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null>;
  listSessions(uid: string): Promise<SessionRecord[]>;
  listOrgSessions(orgId: string): Promise<SessionRecord[]>;
  sessionInOrg(orgId: string, id: string): Promise<SessionRecord | null>;
  assignSession(orgId: string, id: string, assigneeUid: string): Promise<SessionRecord | null>;
  putKeyShares(orgId: string, sessionId: string, shares: SessionKeyShare[]): Promise<boolean>;

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
  membershipOf(uid: string): Promise<Membership | null>;
  members(orgId: string): Promise<Membership[]>;
  removeMember(orgId: string, uid: string): Promise<boolean>;
  setRole(orgId: string, uid: string, role: Role): Promise<boolean>;

  /* ---- Invites ---- */
  putInvite(invite: Invite): Promise<void>;
  invite(id: string): Promise<Invite | undefined>;
  invites(orgId: string): Promise<Invite[]>;
  updateInvite(id: string, patch: Partial<Invite>): Promise<void>;

  /* ---- Audit ---- */
  putAudit(event: AuditEvent): Promise<void>;
  auditFor(orgId: string, sessionId: string): Promise<AuditEvent[]>;
  auditForOrg(orgId: string, limit?: number): Promise<AuditEvent[]>;

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
