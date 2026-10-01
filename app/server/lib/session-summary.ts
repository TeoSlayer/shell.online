import { isP256PublicKey } from "./vault";

/*
 * Owner-only session summaries (summary protocol v1, §3, §6, §7).
 *
 * The service never sees a summary: it stores an `ss1.` envelope sealed on the
 * host (agent transcripts) or inside the attested summarizer enclave (plain
 * terminal output) to the owner's vault key. What it does own is consent,
 * provenance, the publish interval and the short-lived ticket that lets the
 * offline enclave know a request was authorized.
 */

export interface SessionSummary {
  generation: string;
  observedAt: number;
  senderPublicKey: string;
  sealed: string;
}
export interface SessionSummaryPolicy {
  enabled: boolean;
  generation: string;
  ownerUid: string;
  nextPublishAt: number;
}
export type SummaryWriteResult = "stored" | "missing" | "disabled" | "stale" | "limited";
export type SummaryTicketClaim =
  | { result: "issued"; generation: string; ownerUid: string }
  | { result: "missing" | "disabled" | "limited" };

export const SUMMARY_INTERVAL_MS = 2 * 60_000;
export const SUMMARY_TICKET_INTERVAL_MS = 60_000;
export const SUMMARY_TICKET_LIFETIME_MS = 5 * 60_000;
/** PROTOCOL §6: the sealed string, prefix included, is at most 8192 characters. */
export const SUMMARY_SEALED_MAX = 8192;

const FIELDS = ["generation", "observedAt", "senderPublicKey", "sealed"];

export async function readSessionSummary(value: unknown, now = Date.now()): Promise<SessionSummary | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !FIELDS.includes(key))) return null;
  if (typeof body.generation !== "string" || !/^[a-f0-9]{32}$/.test(body.generation)) return null;
  if (typeof body.observedAt !== "number" || !Number.isSafeInteger(body.observedAt) || body.observedAt <= 0 || body.observedAt > now + 60_000) return null;
  if (typeof body.sealed !== "string" || body.sealed.length > SUMMARY_SEALED_MAX || !/^ss1\.[A-Za-z0-9_-]+$/.test(body.sealed)) return null;
  const encoded = body.sealed.slice(4);
  const bytes = Buffer.from(encoded, "base64url");
  // 12-byte nonce + 16-byte tag + at least one byte of plaintext; canonical only.
  if (bytes.length < 29 || bytes.toString("base64url") !== encoded) return null;
  if (!await isP256PublicKey(body.senderPublicKey)) return null;
  return { generation: body.generation, observedAt: body.observedAt, senderPublicKey: body.senderPublicKey as string, sealed: body.sealed };
}

/* ---- Tickets (PROTOCOL §3) ---- */

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export interface SummaryTicketSigner {
  /** The raw 32-byte public key, b64u: what the enclave embeds. */
  publicKey: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Builds a signer from SUMMARY_TICKET_KEY, a b64u 32-byte Ed25519 seed. Anything
 * else is null, and a missing signer makes the ticket route fail closed.
 */
export async function summaryTicketSigner(seed: string | undefined | null): Promise<SummaryTicketSigner | null> {
  if (typeof seed !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(seed)) return null;
  const raw = Buffer.from(seed, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== seed) return null;
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(raw, PKCS8_ED25519_PREFIX.length);
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    if (typeof jwk.x !== "string") return null;
    return {
      publicKey: jwk.x,
      async sign(message) {
        return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message));
      },
    };
  } catch {
    return null;
  } finally {
    pkcs8.fill(0);
    raw.fill(0);
  }
}

export interface SummaryTicketClaims {
  uid: string;
  sessionId: string;
  generation: string;
}

/** `"st1." + b64u(payload) + "." + b64u(Ed25519("st1." + b64u(payload)))`. */
export async function issueSummaryTicket(signer: SummaryTicketSigner, claims: SummaryTicketClaims, now = Date.now()): Promise<string> {
  const jti = new Uint8Array(16);
  crypto.getRandomValues(jti);
  const payload = JSON.stringify({
    v: 1,
    uid: claims.uid,
    session_id: claims.sessionId,
    generation: claims.generation,
    exp: now + SUMMARY_TICKET_LIFETIME_MS,
    jti: b64u(jti),
  });
  const signed = `st1.${b64u(new TextEncoder().encode(payload))}`;
  const signature = await signer.sign(new TextEncoder().encode(signed));
  return `${signed}.${b64u(signature)}`;
}
