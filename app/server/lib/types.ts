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

/**
 * Something a person told us from inside the app.
 *
 * Kept as it was sent, with where in the app it was written, so a report can
 * be read without asking the reporter which screen they meant. Nothing from a
 * terminal is in it: the app never has the plaintext, and the form says so.
 */
export interface Feedback {
  id: string;
  uid: string;
  email: string;
  orgId?: string;
  kind: "problem" | "idea" | "question";
  body: string;
  /** Which control opened the form: "new-session", "session-gate", and so on. */
  surface: string;
  /** The app route it was sent from, path only. */
  route: string;
  appVersion: string;
  userAgent: string;
  /** Whether the sender is happy to be written to about it. */
  canReply: boolean;
  /** A few facts the surface attached, such as the kind of session being started. */
  context: Record<string, string>;
  at: number;
}

/**
 * One account's sign-up time and the days it used the app, with nothing that
 * says which account. What the statistics dashboard's account figures are
 * computed from.
 */
export interface AccountActivity {
  joinedAt: number;
  days: number[];
  /**
   * One of ours rather than a customer's. Decided from the address while the
   * store still has it, so the figures can leave us out without anything
   * outside the store being handed an identifier.
   */
  internal: boolean;
}

/**
 * Things an account can do in the app that the statistics dashboard wants
 * counted, without ever saying which account: linked a machine, registered
 * a session, sent a command. Counted by day and by kind, nothing else.
 */
export const APP_EVENTS = [
  "machine_linked",
  "session_registered",
  "command_sent",
  "vault_created",
  "invite_created",
  "invite_accepted",
  "feedback_sent",
] as const;
export type AppEvent = (typeof APP_EVENTS)[number];

export interface AppEventCount {
  event: AppEvent;
  count: number;
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
  /**
   * "probe" asks the machine to gather statistics and report numbers back.
   *
   * It carries no arguments at all, which is the point: a command that could
   * name a directory, a repository or a file would be a way to ask somebody's
   * machine to look somewhere on behalf of a browser. The agent decides what it
   * reads, on the machine, from its own configuration.
   */
  kind: "start" | "kill" | "probe";
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

/**
 * One gathering run, and what it cost.
 *
 * The elixir vial shows a total, and a total on its own is a number somebody
 * has to take on trust. This is what it is made of. A person who has agreed to
 * their machine being read is owed an itemised account of it rather than a
 * running figure.
 *
 * Every field is a count. There is no branch name here, no commit message, no
 * diff and no session output -- the agent that fills these in runs on the
 * operator's own machine and reports numbers, and this service could not read
 * a session if it wanted to.
 */
export interface GameCollectionRun {
  id: string;
  uid: string;
  deviceId: string;
  /** What the machine calls itself, so the breakdown reads as places. */
  deviceName: string;
  ranAt: number;
  /** What the run spent. The figure in the vial is the sum of these. */
  tokens: number;
  pullRequests: number;
  commits: number;
  insertions: number;
  deletions: number;
  /** Empty when it worked. A run that failed still happened. */
  error: string;
}

/**
 * One account's saved game.
 *
 * See `server/lib/migrations/014_game.sql` for why this is so short: anything
 * the game can work out again is worked out again, so what is kept is only
 * what cannot be. Deleting an account deletes this with it.
 */
export interface GameProfile {
  uid: string;
  /** The class the player chose. Empty until they have chosen. */
  characterClass: string;
  skinId: string;
  /** What this player's soldiers wear. See migration 016. */
  liveryId: string;
  owned: string[];
  /** Marks spent. The purse is what the level earned, less this. */
  spent: number;
  /** Whether they have agreed to their statistics being gathered. */
  gathering: boolean;
  /** Tokens that gathering has cost so far. What the elixir vial shows. */
  tokens: number;
  createdAt: number;
  updatedAt: number;
}
