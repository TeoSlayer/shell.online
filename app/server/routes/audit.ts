import type { AuditEvent, SessionRecord, Store } from "../lib/store";
import { newId, type Membership } from "../lib/orgs";

export const MAX_TEXT = 4100;
const KINDS = new Set(["input", "interrupt", "opened", "handoff", "stopped", "deleted"]);

export interface RecordInput {
  sessionId: string;
  kind: string;
  text: string;
  at?: number;
}

/**
 * Records collaboration metadata for a session.
 *
 * The organization is taken from the actor's membership and the session is
 * checked to belong to it, so an event cannot be written into somebody else's
 * organization by asking nicely. Terminal input is deliberately excluded:
 * the accounts service must not receive a plaintext copy of an E2EE stream.
 */
export async function recordAudit(
  store: Store,
  membership: Membership,
  input: RecordInput,
): Promise<{ ok: true; event: AuditEvent } | { ok: false; status: number; error: string }> {
  if (!KINDS.has(input.kind)) {
    return { ok: false, status: 400, error: "unknown audit kind" };
  }
  const session = await store.sessionInOrg(membership.orgId, input.sessionId);
  if (!session) {
    return { ok: false, status: 404, error: "no such session in this organization" };
  }

  const event: AuditEvent = {
    id: newId("aud"),
    orgId: membership.orgId,
    sessionId: input.sessionId,
    at: typeof input.at === "number" ? input.at : Date.now(),
    actorUid: membership.uid,
    actorEmail: membership.email,
    kind: input.kind as AuditEvent["kind"],
    text: String(input.text ?? "").slice(0, MAX_TEXT),
  };
  await store.putAudit(event);
  return { ok: true, event };
}

/**
 * Hands a session to someone else in the organization.
 *
 * Only the owner of the session, or an admin, may reassign it: the point is a
 * deliberate handover, not anyone quietly taking work off someone's desk.
 */
export async function assignSession(
  store: Store,
  membership: Membership,
  sessionId: string,
  assigneeUids: string[],
): Promise<
  | { ok: true; session: SessionRecord; addedUids: string[] }
  | { ok: false; status: number; error: string }
> {
  const session = await store.sessionInOrg(membership.orgId, sessionId);
  if (!session) return { ok: false, status: 404, error: "no such session" };

  const isOwner = session.ownerUid === membership.uid;
  const isAdmin = membership.role === "owner" || membership.role === "admin";
  if (!isOwner && !isAdmin) {
    return { ok: false, status: 403, error: "only the session's owner can hand it off" };
  }

  const unique = [...new Set(assigneeUids.filter(Boolean))];
  if (unique.length > 50) {
    return { ok: false, status: 400, error: "a session may have at most 50 assignees" };
  }
  const members = await store.members(membership.orgId);
  const byUid = new Map(members.map((entry) => [entry.uid, entry]));
  if (unique.some((uid) => !byUid.has(uid))) {
    return { ok: false, status: 404, error: "an assignee is not in this organization" };
  }

  const previous = session.assigneeUids?.length
    ? session.assigneeUids
    : session.assigneeUid
      ? [session.assigneeUid]
      : [];
  const addedUids = unique.filter((uid) => !previous.includes(uid));

  const updated = await store.assignSession(membership.orgId, sessionId, unique);
  if (!updated) return { ok: false, status: 404, error: "no such session" };

  await recordAudit(store, membership, {
    sessionId,
    kind: "handoff",
    text: unique.length
      ? `assigned to ${unique.map((uid) => byUid.get(uid)?.email).join(", ")}`
      : "cleared assignees",
  });
  return { ok: true, session: updated, addedUids };
}

/** Collaboration metadata as CSV, retained for prerelease API compatibility. */
export function auditCsv(events: AuditEvent[], sessions: SessionRecord[]): string {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const header = ["timestamp", "session", "command", "actor", "kind", "text"];
  const rows = events.map((event) => {
    const session = byId.get(event.sessionId);
    return [
      new Date(event.at).toISOString(),
      event.sessionId,
      session?.name || session?.command || "",
      event.actorEmail,
      event.kind,
      event.text,
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * RFC 4180 quoting.
 *
 * A recorded command can contain commas, quotes and newlines, so an unquoted
 * export would not survive a round trip into a spreadsheet. A leading =, + or
 * @ is also prefixed, because spreadsheets read those as formulas.
 */
function csvCell(value: string): string {
  const guarded = /^[=+@\t\r-]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
