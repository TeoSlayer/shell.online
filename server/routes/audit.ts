import type { AuditEvent, SessionRecord, Store } from "../lib/store";
import { newId, type Membership } from "../lib/orgs";

export const MAX_TEXT = 4100;
const KINDS = new Set(["input", "interrupt", "opened", "handoff"]);

export interface RecordInput {
  sessionId: string;
  kind: string;
  text: string;
  at?: number;
}

/**
 * Records what someone entered in a session.
 *
 * The organization is taken from the actor's membership and the session is
 * checked to belong to it, so an event cannot be written into somebody else's
 * organization by asking nicely.
 */
export function recordAudit(
  store: Store,
  membership: Membership,
  input: RecordInput,
): { ok: true; event: AuditEvent } | { ok: false; status: number; error: string } {
  if (!KINDS.has(input.kind)) {
    return { ok: false, status: 400, error: "unknown audit kind" };
  }
  const session = store.sessionInOrg(membership.orgId, input.sessionId);
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
  store.putAudit(event);
  return { ok: true, event };
}

/**
 * Hands a session to someone else in the organization.
 *
 * Only the owner of the session, or an admin, may reassign it: the point is a
 * deliberate handover, not anyone quietly taking work off someone's desk.
 */
export function assignSession(
  store: Store,
  membership: Membership,
  sessionId: string,
  assigneeUid: string,
): { ok: true; session: SessionRecord } | { ok: false; status: number; error: string } {
  const session = store.sessionInOrg(membership.orgId, sessionId);
  if (!session) return { ok: false, status: 404, error: "no such session" };

  const isOwner = session.ownerUid === membership.uid;
  const isAdmin = membership.role === "owner" || membership.role === "admin";
  if (!isOwner && !isAdmin) {
    return { ok: false, status: 403, error: "only the session's owner can hand it off" };
  }

  const assignee = store.members(membership.orgId).find((entry) => entry.uid === assigneeUid);
  if (!assignee) {
    return { ok: false, status: 404, error: "that person is not in this organization" };
  }

  const updated = store.assignSession(membership.orgId, sessionId, assigneeUid);
  if (!updated) return { ok: false, status: 404, error: "no such session" };

  recordAudit(store, membership, {
    sessionId,
    kind: "handoff",
    text: `assigned to ${assignee.email}`,
  });
  return { ok: true, session: updated };
}

/** The audit log as a CSV file, for taking somewhere else. */
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
