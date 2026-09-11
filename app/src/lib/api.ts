import { auth } from "./firebase";

export { machineOnline } from "./agent";

/*
 * Empty means same origin, which is what a deployment is: the Worker serves
 * this client and answers /api/* itself.
 *
 * The fallback is a development one and must never survive a build. It did
 * once: an unset VITE_ACCOUNTS_URL left a production bundle asking every
 * browser for 127.0.0.1:8787, so the app loaded and then failed on its first
 * request with a message about a service on the user's own machine. Keying
 * the fallback to DEV means forgetting the variable now costs nothing,
 * because same origin is already right for every deployment.
 */
const BASE = (
  import.meta.env.VITE_ACCOUNTS_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:8787" : "")
).replace(/\/+$/, "");

export type Role = "owner" | "admin" | "member";

export interface Member {
  orgId: string;
  uid: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: number;
  /** A browser key from before the vault. Kept only so old shares still name it. */
  publicKey?: string;
  /** Their vault's public key; absent until they have set one up. */
  accountKey?: string;
}

export interface Team {
  id: string;
  name: string;
  createdAt: number;
}

export interface Invite {
  id: string;
  role: Exclude<Role, "owner">;
  email?: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  acceptedBy?: string;
  revokedAt?: number;
}

export interface OrgView {
  organization: Team;
  you: Member;
  members: Member[];
  invites: Invite[];
  joined?: boolean;
  inviteError?: string;
}

export function fetchOrg(inviteId?: string, publicKey?: string) {
  const params = new URLSearchParams();
  if (inviteId) params.set("invite", inviteId);
  /* Published on every load so a new browser becomes reachable at once. */
  if (publicKey) params.set("key", publicKey);
  const query = params.toString();
  return request<OrgView>(`/api/org${query ? `?${query}` : ""}`);
}

export function renameOrg(name: string) {
  return request<{ organization: Team }>("/api/org", {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function createInvite(input: { role: string; email?: string }) {
  return request<{ invite: Invite }>("/api/org/invites", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeInvite(id: string) {
  return request<{ revoked: boolean }>(`/api/org/invites/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function removeMember(uid: string) {
  return request<{ removed: boolean }>(`/api/org/members/${encodeURIComponent(uid)}`, {
    method: "DELETE",
  });
}

export function changeMemberRole(uid: string, role: string) {
  return request<{ changed: boolean }>(`/api/org/members/${encodeURIComponent(uid)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function shareSessionKeys(
  sessionId: string,
  shares: { uid: string; sender_public_key: string; sealed: string }[],
) {
  return request<{ shared: number }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/keys`,
    { method: "PUT", body: JSON.stringify({ shares }) },
  );
}

/** Your vault as the service holds it: a public key and two pieces of ciphertext. */
export interface VaultRecord {
  publicKey: string;
  encryptedPrivateKey: string;
  recoveryWrap: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export function fetchVault() {
  return request<{ vault: VaultRecord | null }>("/api/vault");
}

/** Saves a new vault, or replaces the one at `replaceVersion` when resetting. */
export function saveVault(
  bundle: { publicKey: string; encryptedPrivateKey: string; recoveryWrap: string },
  replaceVersion?: number,
) {
  return request<{ vault: VaultRecord | null }>("/api/vault", {
    method: "POST",
    body: JSON.stringify({
      public_key: bundle.publicKey,
      encrypted_private_key: bundle.encryptedPrivateKey,
      recovery_wrap: bundle.recoveryWrap,
      replace_version: replaceVersion,
    }),
  });
}

export function assignSession(sessionId: string, uids: string[]) {
  return request<{ session: SessionRecord }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/assignee`,
    { method: "PUT", body: JSON.stringify({ uids }) },
  );
}

export interface Comment {
  id: string;
  sessionId: string;
  authorUid: string;
  body: string;
  at: number;
  mentions: string[];
}

export interface Notification {
  id: string;
  uid: string;
  kind: "mention" | "assigned" | "shared";
  sessionId: string;
  actorUid: string;
  body: string;
  at: number;
  readAt?: number;
}

export interface SessionDetail {
  session: SessionRecord;
  members: Member[];
  you: Member;
  comments: Comment[];
}

export function fetchSession(sessionId: string) {
  return request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function postComment(sessionId: string, body: string) {
  return request<{ comment: Comment }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export interface Inbox {
  notifications: Notification[];
  unread: number;
  unreadAssignments: number;
  members: Member[];
}

export function fetchInbox() {
  return request<Inbox>("/api/notifications");
}

export function markNotifications(id?: string) {
  return request<Inbox>("/api/notifications/read", {
    method: "POST",
    body: JSON.stringify(id ? { id } : {}),
  });
}

export interface SessionRecord {
  id: string;
  shareUrl: string;
  command: string;
  name?: string;
  origin?: string;
  orgId?: string;
  ownerUid?: string;
  /** First assignee, retained for compatibility with older app versions. */
  assigneeUid?: string;
  assigneeUids?: string[];
  /** Linked machine that owns the local process. */
  deviceId?: string;
  /** The password sealed to the caller, when one has been shared with them. */
  keyShare?: { senderPublicKey: string; sealed: string };
  /**
   * For the session's owner: who else holds a sealed copy. The service knows
   * this because it stores the copies; it is shown, never used to decide who
   * to seal to.
   */
  sharedWith?: string[];
  readOnly: boolean;
  encrypted: boolean;
  persistent: boolean;
  host: string;
  startedAt: number;
  closedAt?: number;
  exitCode?: number;
}

class ApiError extends Error {}

/*
 * Written for the person reading them. BASE is empty in every deployment, so
 * a message that names it reads "at ." -- and it was never theirs to fix.
 */
export const NETWORK_FAILURE = "Could not reach shell.online. Check your connection and try again.";
export const SERVER_FAILURE = "Something went wrong on our side. Try again.";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new ApiError("You are signed out. Sign in and try again.");

  /*
   * getIdToken refreshes when the cached token is close to expiry, so every
   * call carries a token the accounts service will still accept.
   */
  const token = await user.getIdToken();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new ApiError(NETWORK_FAILURE);
  }

  /*
   * The edge answers an outage with an HTML page, not JSON. The reader is owed
   * a sentence about what happened, not the parser's complaint about a "<".
   */
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ApiError(SERVER_FAILURE);
    }
  }
  if (!response.ok) {
    throw new ApiError(typeof body.error === "string" ? body.error : SERVER_FAILURE);
  }
  return body as T;
}

export interface AuthorizeInput {
  redirectUri: string;
  codeChallenge: string;
}

export function approveCliLogin(input: AuthorizeInput) {
  return request<{ code: string }>("/api/cli/authorize", {
    method: "POST",
    body: JSON.stringify({
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }),
  });
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  at: number;
  actorUid: string;
  actorEmail: string;
  kind: "input" | "interrupt" | "opened" | "handoff" | "stopped" | "deleted";
  text: string;
}

export interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  agentSeenAt?: number;
  /** Published by a running agent so a password can be sealed to it. */
  agentPublicKey?: string;
  /**
   * The agent harnesses this machine's agent found on its PATH. Absent until
   * it has reported, which is not the same as having none of them.
   */
  harnesses?: string[];
}


export function fetchDevices() {
  return request<{ devices: Device[] }>("/api/devices");
}

export function revokeDevice(id: string) {
  return request<{ revoked: boolean }>(`/api/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface StartInput {
  deviceId: string;
  command: string;
  name: string;
  /** A password sealed to the agent; this service cannot read it. */
  senderPublicKey?: string;
  sealedPassword?: string;
}

export function startSession(input: StartInput) {
  return request<{ command: { id: string } }>("/api/commands", {
    method: "POST",
    body: JSON.stringify({
      device_id: input.deviceId,
      kind: "start",
      command: input.command,
      name: input.name,
      sender_public_key: input.senderPublicKey,
      sealed_password: input.sealedPassword,
    }),
  });
}

export function stopSession(deviceId: string, sessionId: string) {
  return request<{ command: { id: string } }>("/api/commands", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId, kind: "kill", session_id: sessionId }),
  });
}

export function fetchSessions() {
  return request<{ sessions: SessionRecord[]; members: Member[]; you: Member }>(
    "/api/sessions",
  );
}

export const accountsBaseUrl = BASE;

export function postAudit(entries: { session_id: string; kind: string; text: string; at: number }[]) {
  return request<{ written: number }>("/api/audit", {
    method: "POST",
    body: JSON.stringify({ entries }),
  });
}

/*
 * Removes a session from the lists.
 *
 * The row, not the machine. The process has already exited, or is being
 * abandoned deliberately; what it left on disk belongs to whoever ran it.
 */
export function deleteSession(sessionId: string) {
  return request<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export interface AuditPageRequest {
  page?: number;
  limit?: number;
  session?: string;
  actor?: string;
  kind?: string;
  query?: string;
  sinceAt?: number;
}

/** The team's trail, filtered and paged by the service rather than the browser. */
export function fetchOrgAudit(input: AuditPageRequest = {}) {
  const params = new URLSearchParams();
  if (input.page) params.set("page", String(input.page));
  if (input.limit) params.set("limit", String(input.limit));
  if (input.session) params.set("session", input.session);
  if (input.actor) params.set("actor", input.actor);
  if (input.kind) params.set("kind", input.kind);
  if (input.query?.trim()) params.set("q", input.query.trim());
  if (input.sinceAt) params.set("since_at", String(input.sinceAt));
  const query = params.toString();
  return request<{ events: AuditEvent[]; total: number; page: number; limit: number }>(
    `/api/audit${query ? `?${query}` : ""}`,
  );
}

export function fetchAudit(sessionId: string) {
  return request<{ events: AuditEvent[] }>(`/api/audit/${encodeURIComponent(sessionId)}`);
}


/** The audit export needs the same bearer token, so it is fetched not linked. */
export async function downloadAuditCsv(sessionId?: string): Promise<Blob> {
  const user = auth.currentUser;
  if (!user) throw new Error("You are signed out.");
  const token = await user.getIdToken();
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/audit.csv${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(NETWORK_FAILURE);
  }
  if (!response.ok) throw new Error("Could not export the audit log.");
  return response.blob();
}
