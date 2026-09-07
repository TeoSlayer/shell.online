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
}

const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export type RegisterResult =
  | { ok: true; session: SessionRecord; isNew: boolean }
  | { ok: false; reason: string };

/**
 * The CLI supplies the session id minted by the relay. It is echoed back into
 * the share URL and the UI, so it is validated here rather than trusted.
 */
export function registerSession(
  store: Store,
  uid: string,
  input: SessionInput,
  now = Date.now(),
): RegisterResult {
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
    shareUrl: input.shareUrl,
    command: input.command.slice(0, 300),
    name: typeof input.name === "string" && input.name.trim()
      ? input.name.trim().slice(0, 120)
      : undefined,
    origin: typeof input.origin === "string" && input.origin
      ? input.origin.slice(0, 200)
      : undefined,
    readOnly: Boolean(input.readOnly),
    encrypted: Boolean(input.encrypted),
    persistent: Boolean(input.persistent),
    host: (input.host ?? "").slice(0, 120),
    startedAt: typeof input.startedAt === "number" ? input.startedAt : now,
  };
  const isNew = store.upsertSession(session);
  return { ok: true, session, isNew };
}

export function closeSession(
  store: Store,
  uid: string,
  id: string,
  exitCode: number | undefined,
  now = Date.now(),
): SessionRecord | null {
  return store.patchSession(uid, id, { closedAt: now, exitCode });
}

export function listSessions(store: Store, uid: string): SessionRecord[] {
  return store.listSessions(uid);
}
