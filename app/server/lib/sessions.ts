import type { Membership } from "./orgs";
import type { SessionRecord, Store } from "./store";

export interface SessionInput {
  id: string;
  shareUrl: string;
  command: string;
  name?: string;
  origin?: string;
  readOnly?: boolean;
  encrypted?: boolean;
  persistent?: boolean;
  host?: string;
  startedAt?: number;
  orgId?: string;
  ownerUid?: string;
  deviceId?: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const SOURCE_PREFIX = "shell-online-source:";

interface SessionSource {
  origin?: string;
  deviceId?: string;
}

function packSource(origin: string | undefined, deviceId: string | undefined): string | undefined {
  const cleanOrigin = typeof origin === "string" && origin ? origin.slice(0, 200) : undefined;
  if (!deviceId) return cleanOrigin;
  return `${SOURCE_PREFIX}${JSON.stringify({ version: 1, deviceId, origin: cleanOrigin })}`;
}

/** Reads the owning machine and browser command from new and legacy rows. */
export function sessionSource(session: Pick<SessionRecord, "origin">): SessionSource {
  if (!session.origin?.startsWith(SOURCE_PREFIX)) return { origin: session.origin };
  try {
    const source = JSON.parse(session.origin.slice(SOURCE_PREFIX.length)) as Record<string, unknown>;
    if (source.version !== 1 || typeof source.deviceId !== "string") return {};
    return {
      deviceId: source.deviceId,
      origin: typeof source.origin === "string" ? source.origin : undefined,
    };
  } catch {
    return {};
  }
}

/** Removes the storage envelope before a session is sent to the browser. */
export function sessionForApi(session: SessionRecord) {
  const source = sessionSource(session);
  /*
   * Key shares are recipient-specific credentials. Routes serving a browser
   * add back only that caller's `keyShare`; CLI registration/close responses
   * need none of them.
   */
  const { keyShares: _keyShares, ...safe } = session;
  return { ...safe, origin: source.origin, deviceId: source.deviceId };
}

/** The longest label kept. Longer ones are cut, not refused. */
export const SESSION_NAME_LIMIT = 120;

/**
 * A session label as it is stored: one line, trimmed, and bounded. Blank means
 * no name at all, so the command is shown in its place.
 */
export function sessionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  /*
   * A newline or escape in a label would break every list it appears in, and
   * a direction override would rewrite the rest of the row around it: a name
   * ending in U+202E makes a terminal print the columns after it backwards,
   * so a finished session can be dressed up as something else in `shell ls`.
   * C0, DEL, C1 and the bidi controls all go.
   */
  const line = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return line ? [...line].slice(0, SESSION_NAME_LIMIT).join("") : undefined;
}

/**
 * Naming is housekeeping, not control over the machine, so it is open to the
 * people responsible for the session: whoever started it, whoever it is
 * assigned to, and whoever runs the team.
 */
export function mayRenameSession(membership: Membership, session: SessionRecord): boolean {
  if ((session.ownerUid ?? session.uid) === membership.uid) return true;
  if (membership.role === "owner" || membership.role === "admin") return true;
  const assignees = session.assigneeUids?.length
    ? session.assigneeUids
    : session.assigneeUid
      ? [session.assigneeUid]
      : [];
  return assignees.includes(membership.uid);
}

export async function renameSession(
  store: Store,
  membership: Membership,
  sessionId: string,
  name: unknown,
): Promise<
  | { ok: true; session: SessionRecord }
  | { ok: false; status: number; error: string }
> {
  if (name !== null && name !== undefined && typeof name !== "string") {
    return { ok: false, status: 400, error: "a name must be text" };
  }
  const session = await store.sessionInOrg(membership.orgId, sessionId);
  if (!session) return { ok: false, status: 404, error: "no such session" };
  if (!mayRenameSession(membership, session)) {
    return { ok: false, status: 403, error: "only the session's owner, assignees or a team admin can rename it" };
  }
  const updated = await store.renameSession(membership.orgId, sessionId, sessionName(name));
  if (!updated) return { ok: false, status: 404, error: "no such session" };
  return { ok: true, session: updated };
}

export type RegisterResult =
  | { ok: true; session: SessionRecord; isNew: boolean }
  | { ok: false; reason: string };

/**
 * The CLI supplies the session id minted by the relay. It is echoed back into
 * the share URL and the UI, so it is validated here rather than trusted.
 */
export async function registerSession(
  store: Store,
  uid: string,
  input: SessionInput,
  now = Date.now(),
): Promise<RegisterResult> {
  if (!input || typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
    return { ok: false, reason: "invalid session id" };
  }
  if (typeof input.shareUrl !== "string" || !/^https?:\/\//.test(input.shareUrl)) {
    return { ok: false, reason: "invalid share url" };
  }
  if (typeof input.command !== "string" || input.command.length === 0) {
    return { ok: false, reason: "invalid command" };
  }

  const session: SessionRecord = {
    id: input.id,
    uid,
    orgId: input.orgId,
    ownerUid: input.ownerUid ?? uid,
    /* The person who started it is responsible until they hand it over. */
    assigneeUid: input.ownerUid ?? uid,
    assigneeUids: [input.ownerUid ?? uid],
    shareUrl: input.shareUrl,
    command: input.command.slice(0, 300),
    name: sessionName(input.name),
    /* Reuse the existing source column so this upgrade needs no schema race. */
    origin: packSource(input.origin, input.deviceId),
    readOnly: Boolean(input.readOnly),
    encrypted: Boolean(input.encrypted),
    persistent: Boolean(input.persistent),
    host: (input.host ?? "").slice(0, 120),
    startedAt: typeof input.startedAt === "number" ? input.startedAt : now,
  };
  const isNew = await store.upsertSession(session);
  return { ok: true, session, isNew };
}

export async function closeSession(
  store: Store,
  uid: string,
  id: string,
  exitCode: number | undefined,
  now = Date.now(),
): Promise<SessionRecord | null> {
  return await store.patchSession(uid, id, { closedAt: now, exitCode });
}

export async function listSessions(store: Store, uid: string): Promise<SessionRecord[]> {
  return await store.listSessions(uid);
}
