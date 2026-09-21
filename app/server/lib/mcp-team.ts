import type { SessionRecord } from "./types";
import { sessionSource } from "./sessions";
import { sealToAccount } from "../../src/lib/vault-crypto";

/**
 * A teammate's request for an observe-only MCP grant on a session whose owner
 * opted into team MCP.
 *
 * The request is the meeting point between two people who never share a secret
 * directly: the teammate (their own account) asks, and the session's own
 * machine answers by minting a grant through the existing host-token path and
 * reporting the opaque bearer back.
 *
 * The bearer is a usable credential even though it is a JWE, so the service
 * seals it to the temporary public key supplied by the requester before
 * persistence. The requesting client holds the private key only in memory.
 * Encryption failure never falls back to storing the usable bearer.
 */

/** How long a request waits for the session's machine to answer. */
export const MCP_TEAM_REQUEST_TTL = 5 * 60_000;
/** Unanswered requests one session may hold. */
export const MCP_TEAM_PENDING_LIMIT = 4;
/** Issued, not yet acknowledged-revoked, grants one session may hold. */
export const MCP_TEAM_ISSUED_LIMIT = 8;
/** Revoked, not yet acknowledged, records one session may hold. */
export const MCP_TEAM_REVOKED_LIMIT = 8;
/**
 * The table's total backstop, across all sessions. The per-session caps and
 * the TTLs already keep a healthy table small; this is what bounds a burst of
 * many sessions at once.
 */
export const MCP_TEAM_GLOBAL_LIMIT = 512;
/** The DO's bearer size bound, mirrored so a report cannot carry more. */
export const MCP_TEAM_BEARER_LIMIT = 8192;
/** The longest a team grant may run: the observe preset's maximum. */
export const MCP_TEAM_GRANT_MAX = 12 * 60 * 60_000;
/** A row that has done everything it can is swept this long after. */
const MCP_TEAM_SWEEP_GRACE = 60 * 60_000;

export type McpTeamRequestStatus = "pending" | "issued" | "revoked";

export interface McpTeamRequest {
  requestId: string;
  orgId: string;
  sessionId: string;
  requesterUid: string;
  recipientPublicKey: string;
  status: McpTeamRequestStatus;
  createdAt: number;
  /** When a pending request stops being answerable. */
  expiresAt: number;
  grantId?: string;
  grantExpiresAt?: number;
  /**
   * The credential, present only on the one fetch that delivers it: the
   * recipient-bound encrypted envelope. A row that
   * has been delivered keeps everything except this.
   */
  bearer?: string;
  /** Always true for a delivered credential. */
  sealedToRecipient: boolean;
  /** When the credential was delivered, if it has been. */
  deliveredAt?: number;
  issuedAt?: number;
  revokedAt?: number;
}

/** What the session's machine reports after minting the grant. */
export interface McpTeamGrantReport {
  grantId: string;
  expiresAt: number;
  bearer: string;
}

/** One item in the host's work list. */
export interface McpTeamHostRequest {
  requestId: string;
  requesterUid: string;
  action: "issue" | "revoke";
  grantId?: string;
  /** The pending deadline, for an issue. */
  expiresAt?: number;
}

export type McpTeamRequestResult = "stored" | "missing" | "closed" | "disabled" | "limited";
export type McpTeamReportResult = "stored" | "missing" | "expired" | "revoked";

/** The DO's grant ids: 16 random bytes, unpadded base64url. Case is significant. */
const GRANT_ID = /^[A-Za-z0-9_-]{22}$/;
/**
 * Compact JWE: five base64url segments. The service cannot open any of them
 * and does not need to; the shape is what keeps a report from carrying
 * anything that is not a bearer.
 */
const JWE_COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Reads the host's grant report strictly.
 *
 * Every field is checked for type as well as value: a coerced string would
 * let a report carry a number where a deadline is expected, and the DO's
 * clock is the only one that matters here.
 */
export function readTeamGrantReport(value: unknown, now = Date.now()): McpTeamGrantReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["grantId", "expiresAt", "bearer"].includes(key))) return null;
  if (typeof body.grantId !== "string" || !GRANT_ID.test(body.grantId)) return null;
  if (
    typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt) ||
    body.expiresAt <= now || body.expiresAt > now + MCP_TEAM_GRANT_MAX + 5000
  ) return null;
  if (typeof body.bearer !== "string" || body.bearer.length < 1 || body.bearer.length > MCP_TEAM_BEARER_LIMIT) return null;
  if (!JWE_COMPACT.test(body.bearer)) return null;
  return { grantId: body.grantId, expiresAt: body.expiresAt, bearer: body.bearer };
}

/**
 * Uses the existing ECDH/HKDF/AES-GCM construction with additional request
 * binding, so a delivery cannot be substituted across requests or accounts.
 * Throws on any sealing failure; the caller must never persist the bearer.
 */
export async function sealTeamBearer(
  recipientPublicKey: string,
  sessionId: string,
  requesterUid: string,
  requestId: string,
  bearer: string,
): Promise<string> {
  const share = await sealToAccount(recipientPublicKey, sessionId, `${requesterUid}\u0000mcp-team:${requestId}`, bearer);
  return JSON.stringify({ k: share.senderPublicKey, s: share.sealed });
}

/**
 * The machine that may answer a session's team requests: its owner, from the
 * device the session was published by. The same bound the content publisher
 * uses, because it is the same question -- is this the session's own machine?
 */
export function teamPublisher(session: SessionRecord, orgId: string, ownerUid: string, deviceId: string): boolean {
  return session.orgId === orgId && (session.ownerUid ?? session.uid) === ownerUid &&
    !!deviceId && sessionSource(session).deviceId === deviceId;
}

/**
 * A row's work is done, and it can be swept, when:
 * - it is pending and past its deadline by the grace,
 * - it is revoked and past the grace since,
 * - it is issued and its grant is past its expiry by the grace.
 */
export function mcpTeamRowSweepable(row: McpTeamRequest, now: number): boolean {
  if (row.status === "pending") return now - row.expiresAt >= MCP_TEAM_SWEEP_GRACE;
  if (row.status === "revoked") return now - (row.revokedAt ?? row.createdAt) >= MCP_TEAM_SWEEP_GRACE;
  return now - (row.grantExpiresAt ?? row.createdAt) >= MCP_TEAM_SWEEP_GRACE;
}

const capFor = (status: McpTeamRequestStatus): number =>
  status === "pending" ? MCP_TEAM_PENDING_LIMIT : status === "issued" ? MCP_TEAM_ISSUED_LIMIT : MCP_TEAM_REVOKED_LIMIT;

/**
 * Keeps the rows at their bounds. The caps are enforced at write time; this
 * is the backstop. A row over its cap is revoked, not deleted: it stays until
 * the sweep, and a revoked row is one the host stops acting on.
 */
export function trimMcpTeamRows(rows: McpTeamRequest[], now: number): McpTeamRequest[] {
  const result = rows.filter((row) => !mcpTeamRowSweepable(row, now));
  const perSession = new Map<string, McpTeamRequest[]>();
  for (const row of result) {
    const key = `${row.orgId}\u0000${row.sessionId}`;
    const list = perSession.get(key) ?? [];
    list.push(row);
    perSession.set(key, list);
  }
  for (const list of perSession.values()) {
    list.sort((a, b) => b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId));
    const seen: Record<McpTeamRequestStatus, number> = { pending: 0, issued: 0, revoked: 0 };
    for (const row of list) {
      seen[row.status] += 1;
      if (seen[row.status] > capFor(row.status) && row.status !== "revoked") {
        row.status = "revoked";
        row.revokedAt = now;
      }
    }
  }
  if (result.length > MCP_TEAM_GLOBAL_LIMIT) {
    result.sort((a, b) => b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId));
    for (const row of result.slice(MCP_TEAM_GLOBAL_LIMIT)) {
      if (row.status !== "revoked") {
        row.status = "revoked";
        row.revokedAt = now;
      }
    }
  }
  return result;
}
