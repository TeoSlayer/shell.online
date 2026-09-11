import type { AuditEvent, SessionRecord, Store } from "../lib/store";
import { newId, type Membership } from "../lib/orgs";
import { isAuditEnvelope } from "../lib/audit-seal";

export const MAX_TEXT = 4100;
const KINDS = new Set(["input", "interrupt", "opened", "handoff", "stopped", "deleted"]);

/**
 * The kinds a browser writes: what a person typed. They arrive sealed to the
 * team's audit key and nothing else is accepted for them. The rest are written
 * by the service itself and hold only what it already stores: session names
 * and the addresses of the people involved.
 */
export const SEALED_KINDS = new Set(["input", "interrupt"]);

export interface RecordInput {
  sessionId: string;
  kind: string;
  text: string;
  at?: number;
}

/**
 * Records an event in a session's audit trail.
 *
 * The organization is taken from the actor's membership and the session is
 * checked to belong to it, so an event cannot be written into somebody else's
 * organization by asking nicely.
 *
 * Typed input is recorded, by the operator's choice, but only as ciphertext
 * sealed in the browser to a key the team holds: plaintext is refused. The
 * envelope is stored exactly as it came, and so is its time, because the
 * browser binds the time into the ciphertext. Trimming the one or replacing
 * the other would make the entry unreadable to the team it was written for.
 */
export async function recordAudit(
  store: Store,
  membership: Membership,
  input: RecordInput,
): Promise<{ ok: true; event: AuditEvent } | { ok: false; status: number; error: string }> {
  if (!KINDS.has(input.kind)) {
    return { ok: false, status: 400, error: "unknown audit kind" };
  }
  const sealed = SEALED_KINDS.has(input.kind);
  if (sealed) {
    if (!(await isAuditEnvelope(input.text))) {
      return { ok: false, status: 400, error: "typed input must be sealed to the team's audit key" };
    }
    if (typeof input.at !== "number" || !Number.isInteger(input.at)) {
      return { ok: false, status: 400, error: "sealed input must carry the time it was sealed with" };
    }
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
    text: sealed ? input.text : String(input.text ?? "").slice(0, MAX_TEXT),
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
  const header = ["timestamp", "session", "command", "actor", "kind", "text", "sealed_by"];
  const rows = events.map((event) => {
    const session = byId.get(event.sessionId);
    return [
      new Date(event.at).toISOString(),
      event.sessionId,
      session?.name || session?.command || "",
      event.actorEmail,
      event.kind,
      event.text,
      /* Empty for an entry that arrived sealed from the browser that wrote it. */
      event.sealedBy ?? "",
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
