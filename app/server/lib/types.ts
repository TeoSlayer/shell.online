export type { Invite, Membership, Organization, Role } from "./orgs";

export interface AuthorizationCode {
  code: string;
  uid: string;
  email: string;
  name: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
  consumedAt?: number;
}

export interface CliToken {
  /** Stable public id for this device. Safe to show and to address in a URL. */
  id: string;
  /** SHA-256 of the presented secret. The secret itself is never stored. */
  accessHash: string;
  refreshHash: string;
  uid: string;
  email: string;
  name: string;
  label: string;
  /**
   * The machine this login came from, when the CLI could name one. Signing in
   * again from the same machine rotates this row rather than adding another,
   * so an account's device list stays one entry per physical machine.
   */
  machineId?: string;
  accessExpiresAt: number;
  createdAt: number;
  lastSeenAt: number;
  /**
   * When `shell agent` last asked for work. Distinct from lastSeenAt, which
   * any authenticated call touches: only a polling agent can accept a command,
   * so only its polling should count as being online.
   */
  agentSeenAt?: number;
  /** Published by a running agent so a browser can seal a password to it. */
  agentPublicKey?: string;
  /**
   * The agent harnesses the polling agent found on this machine's PATH.
   *
   * Absent means the machine has never reported, which is not the same as
   * reporting none: the browser may say a tool is missing from a machine only
   * when that machine has said so itself.
   */
  harnesses?: string[];
  revokedAt?: number;
}

/** A linked machine, with every secret removed. */
export interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  agentSeenAt?: number;
  agentPublicKey?: string;
  /** What the agent reported finding on PATH; absent until it has reported. */
  harnesses?: string[];
  revokedAt?: number;
}

export interface AuditEvent {
  id: string;
  orgId: string;
  sessionId: string;
  at: number;
  actorUid: string;
  actorEmail: string;
  kind: "input" | "interrupt" | "opened" | "handoff" | "stopped" | "deleted";
  text: string;
  /**
   * Who sealed this entry afterwards, when a team encrypted a log it had kept
   * before it had an audit key. Absent means first-hand: it arrived sealed
   * from the browser that recorded it. A re-sealed entry was sealed by
   * somebody handed its session, author and time by this service, so it is
   * only as trustworthy as they are, and a reader is told which it is.
   */
  sealedBy?: string;
}

/**
 * A session password sealed to one member.
 *
 * Older shares are sealed to a browser key; newer ones to the member's account
 * key, marked by a "v2." prefix on `sealed`. The service cannot tell them
 * apart any better than that and does not need to.
 */
export interface SessionKeyShare {
  uid: string;
  senderPublicKey: string;
  sealed: string;
}

/**
 * A person's session vault.
 *
 * The public key is what session passwords are sealed to. The private key is
 * held only encrypted under a vault key, and the vault key only wrapped under
 * a recovery key this service never receives, so none of this opens anything
 * here.
 */
export interface AccountKey {
  uid: string;
  publicKey: string;
  encryptedPrivateKey: string;
  recoveryWrap: string;
  /** Starts at 1 and counts resets. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * An organization's audit key.
 *
 * The public half of a key pair whose private half the team's members hold,
 * each copy sealed to that member's vault. Typed input is sealed to it in the
 * browser, so the audit log the service stores is one it cannot read.
 */
export interface TeamKey {
  orgId: string;
  publicKey: string;
  /** Which key an entry was sealed to, so one can be replaced without losing the old. */
  version: number;
  createdBy: string;
  createdAt: number;
}

/** One member's copy of the team's private audit key, sealed to them by a teammate. */
export interface TeamKeyShare {
  orgId: string;
  uid: string;
  version: number;
  /** Who sealed it, so the reader can check the copy came from a teammate's vault. */
  senderUid: string;
  sealed: string;
  createdAt: number;
}

export interface Comment {
  id: string;
  orgId: string;
  sessionId: string;
  authorUid: string;
  body: string;
  at: number;
  mentions: string[];
}

/**
 * Something that happened which a person should know about.
 *
 * "mention" is frequent and low-stakes. "assigned" is rare and means work has
 * moved onto someone's plate, so the two are distinguished here rather than
 * left for the UI to guess at.
 */
export interface Notification {
  id: string;
  orgId: string;
  uid: string;
  kind: "mention" | "assigned" | "shared";
  sessionId: string;
  actorUid: string;
  body: string;
  at: number;
  readAt?: number;
}

export interface SessionRecord {
  id: string;
  uid: string;
  /** The organization the session belongs to, so colleagues can see it. */
  orgId?: string;
  /** Who started it. */
  ownerUid?: string;
  /** First assignee, retained for clients from before multi-assignment. */
  assigneeUid?: string;
  /** Everyone currently responsible for the session. */
  assigneeUids?: string[];
  /**
   * The session password, sealed once per member. The service relays these
   * and can open none of them.
   */
  keyShares?: SessionKeyShare[];
  shareUrl: string;
  command: string;
  /** The queued request this session came from, when it came from one. */
  origin?: string;
  /** Operator-chosen label. Falls back to the command when absent. */
  name?: string;
  readOnly: boolean;
  encrypted: boolean;
  persistent: boolean;
  host: string;
  startedAt: number;
  closedAt?: number;
  exitCode?: number;
}

/**
 * Work the web app asks a machine to do. A machine only sees these while it is
 * running `shell agent`, which is how a person opts a machine in to being
 * driven from the browser.
 */
export interface AgentCommand {
  id: string;
  uid: string;
  deviceId: string;
  kind: "start" | "kill";
  /** For "start": the command line to wrap. */
  command?: string;
  /** For "start": what to call the session in the UI. */
  name?: string;
  /**
   * For "start": a browser password sealed to the agent's key. Relayed as
   * opaque bytes; this service cannot open it, which is the point.
   */
  senderPublicKey?: string;
  sealedPassword?: string;
  /** For "kill": the session to stop. */
  sessionId?: string;
  createdAt: number;
  claimedAt?: number;
  doneAt?: number;
  error?: string;
}


/**
 * File-backed store for local development. Every read and write goes through
 * this interface so the production implementation (Firestore, D1) can drop in
 * without touching route code.
 */
