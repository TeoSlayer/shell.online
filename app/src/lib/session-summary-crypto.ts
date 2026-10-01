/*
 * Opens an `ss1.` owner-only session summary (summary protocol v1, §6).
 *
 * Same construction as `sc1.` session content with an independent purpose
 * string, so neither envelope can be replayed as the other. The summary was
 * produced from untrusted terminal output, so after decryption it is checked
 * again against the output guard: plain text only, bounded, no links, no
 * addresses, no markup. Anything that fails is dropped, never shown "mostly".
 */
const CONTEXT = "shell.online session summary v1";
const PREFIX = "ss1.";
const encoder = new TextEncoder();

export const SUMMARY_STATES = ["working", "waiting_for_input", "idle", "error", "finished", "unknown"] as const;
export const SUMMARY_SOURCES = ["enclave", "claude-code", "codex", "opencode"] as const;
export type SummaryState = (typeof SUMMARY_STATES)[number];
export type SummarySource = (typeof SUMMARY_SOURCES)[number];

export interface SessionSummary {
  version: 1;
  title: string;
  summary: string;
  state: SummaryState;
  source: SummarySource;
  observedAt: number;
}

// C0/C1 controls, bidi overrides/isolates, zero-width and other format characters.
// oxlint-disable-next-line no-control-regex -- rejecting control characters is the point.
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/u;
const SURROGATE = /[\ud800-\udfff]/u;

/*
 * The enclave output guard's link and markup rules, mirrored from
 * shell-online-summarizer internal/guard (keep the two in step). A summary may
 * name a file, a command or an error, but never something a reader could
 * follow: no scheme URL, no www host, no host on a common public suffix, no
 * e-mail or IP address, no Markdown link, image or fence, no HTML or entity.
 */
const LINK_OR_MARKUP = [
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/|\bwww\.|\b(?:data|javascript|vbscript|file|mailto|tel|sms):\S/i,
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|net|org|io|co|ai|app|dev|xyz|me|info|biz|ru|cn|tk|top|online|site|link|click|ly|gl|gg|uk|de|fr|ws|page|live|shop|store|support|help|login|cloud)\b/i,
  /[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/,
  /<[a-z/!?][^>]*>|\]\(|!\[|```|\[[^\]]*\]\s*\[|&[a-z]+;|&#/i,
];

export function guardSummaryText(value: unknown, max: number, multiline: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max * 2) return false;
  if ([...value].length > max || value.trim().length === 0) return false;
  if (SURROGATE.test(value)) return false;
  if (FORBIDDEN_CHARS.test(multiline ? value.replace(/\n/g, "") : value)) return false;
  return !LINK_OR_MARKUP.some((pattern) => pattern.test(value));
}

function validBinding(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !FORBIDDEN_CHARS.test(value) && !SURROGATE.test(value);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (canonical !== value) throw new Error("noncanonical base64url");
  return bytes;
}

export function summaryAAD(sessionId: string, recipientUid: string, generation: string, observedAt: number): Uint8Array<ArrayBuffer> {
  // Go's JSON encoder escapes these two separators, including with HTML escaping off.
  return encoder.encode(JSON.stringify([CONTEXT, sessionId, recipientUid, generation, observedAt])
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"));
}

/** Validates a decrypted plaintext against §6 and the output guard. */
export function readSummaryPlaintext(value: unknown, observedAt: number): SessionSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  if (Object.keys(summary).sort().join(",") !== "observedAt,source,state,summary,title,version") return null;
  if (summary.version !== 1 || summary.observedAt !== observedAt) return null;
  if (!(SUMMARY_STATES as readonly unknown[]).includes(summary.state)) return null;
  if (!(SUMMARY_SOURCES as readonly unknown[]).includes(summary.source)) return null;
  if (!guardSummaryText(summary.title, 80, false) || !guardSummaryText(summary.summary, 480, true)) return null;
  return summary as unknown as SessionSummary;
}

/** Opens only a summary bound to this owner's session generation. No caching or IO. */
export async function openSessionSummary(
  privateKey: CryptoKey,
  sessionId: string,
  recipientUid: string,
  generation: string,
  observedAt: number,
  share: { senderPublicKey: string; sealed: string },
): Promise<SessionSummary | null> {
  try {
    if (![sessionId, recipientUid, generation].every(validBinding)
      || !Number.isSafeInteger(observedAt) || observedAt <= 0
      || typeof share?.senderPublicKey !== "string" || share.senderPublicKey.length !== 87
      || typeof share?.sealed !== "string" || !share.sealed.startsWith(PREFIX) || share.sealed.length > 8192) return null;
    const envelope = decode(share.sealed.slice(PREFIX.length));
    if (envelope.length < 29) return null;
    const sender = await crypto.subtle.importKey("raw", decode(share.senderPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, privateKey, 256));
    let key: CryptoKey;
    try {
      const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
      key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(CONTEXT) }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    } finally { shared.fill(0); }
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: envelope.slice(0, 12), additionalData: summaryAAD(sessionId, recipientUid, generation, observedAt) },
      key, envelope.slice(12)));
    try {
      return readSummaryPlaintext(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)), observedAt);
    } finally { plaintext.fill(0); }
  } catch { return null; }
}
