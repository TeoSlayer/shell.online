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
  return { ...session, origin: source.origin, deviceId: source.deviceId };
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
    name: typeof input.name === "string" && input.name.trim()
      ? input.name.trim().slice(0, 120)
      : undefined,
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
