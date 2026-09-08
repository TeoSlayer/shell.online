import { auth } from "./firebase";

export { machineOnline } from "./agent";

const BASE = (import.meta.env.VITE_ACCOUNTS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

export type Role = "owner" | "admin" | "member";

export interface Member {
  orgId: string;
  uid: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: number;
  /** Their browser key, so a session password can be sealed to them. */
  publicKey?: string;
}

export interface Organization {
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
  organization: Organization;
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
  return request<{ organization: Organization }>("/api/org", {
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

export function assignSession(sessionId: string, uid: string) {
  return request<{ session: SessionRecord }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/assignee`,
    { method: "PUT", body: JSON.stringify({ uid }) },
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
  assigneeUid?: string;
  /** Linked machine that owns the local process. */
  deviceId?: string;
  /** The password sealed to the caller, when one has been shared with them. */
  keyShare?: { senderPublicKey: string; sealed: string };
  readOnly: boolean;
  encrypted: boolean;
  persistent: boolean;
  host: string;
  startedAt: number;
  closedAt?: number;
  exitCode?: number;
}

class ApiError extends Error {}

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
    throw new ApiError(
      `Could not reach the accounts service at ${BASE}. Is it running?`,
    );
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(String(body.error ?? `Request failed with ${response.status}`));
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
