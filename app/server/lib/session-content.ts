import type { SessionRecord } from "./types";
import { sessionSource } from "./sessions";
import { isP256PublicKey } from "./vault";

export interface SessionContent {
  generation: string;
  observedAt: number;
  senderPublicKey: string;
  sealed: string;
}
export interface SessionContentPolicy {
  enabled: boolean;
  generation: string;
  ownerUid: string;
  nextPublishAt: number;
}
export type ContentWriteResult = "stored" | "missing" | "disabled" | "stale" | "limited";
export const CONTENT_INTERVAL_MS = 24 * 60 * 60_000;

export function contentPublisher(session: SessionRecord, orgId: string, ownerUid: string, deviceId: string): boolean {
  return session.orgId === orgId && (session.ownerUid ?? session.uid) === ownerUid &&
    !!deviceId && sessionSource(session).deviceId === deviceId;
}

export async function readSessionContent(value: unknown): Promise<SessionContent | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["generation", "observedAt", "senderPublicKey", "sealed"].includes(key))) return null;
  if (typeof body.generation !== "string" || !/^[a-f0-9]{32}$/.test(body.generation)) return null;
  if (typeof body.observedAt !== "number" || !Number.isSafeInteger(body.observedAt) || body.observedAt < 0 || body.observedAt > Date.now() + 60_000) return null;
  if (typeof body.sealed !== "string" || !/^sc1\.[A-Za-z0-9_-]+$/.test(body.sealed) || body.sealed.length > 21_850) return null;
  const encoded = body.sealed.slice(4);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length < 29 || bytes.length > 16 * 1024 || bytes.toString("base64url") !== encoded) return null;
  if (!await isP256PublicKey(body.senderPublicKey)) return null;
  return body as unknown as SessionContent;
}
