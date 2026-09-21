const CONTEXT = "shell.online session content v1";
const PREFIX = "sc1.";
const encoder = new TextEncoder();

export interface SessionContent {
  version: 1;
  suggestedTitle: string;
  description: string;
  source: "opencode-launch" | "generic";
  observedAt: number;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max * 2 && [...value].length <= max
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    && !/[\ud800-\udfff]/u.test(value);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (canonical !== value) throw new Error("noncanonical base64url");
  return bytes;
}

/** Opens only content bound to this owner's session generation. No caching or IO. */
export async function openSessionContent(
  privateKey: CryptoKey,
  sessionId: string,
  recipientUid: string,
  generation: string,
  observedAt: number,
  share: { senderPublicKey: string; sealed: string },
): Promise<SessionContent | null> {
  try {
    if (![sessionId, recipientUid, generation].every((value) => validText(value, 256) && value.length > 0)
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
    // Go's JSON encoder escapes these two separators, including with HTML escaping off.
    const aad = JSON.stringify([CONTEXT, sessionId, recipientUid, generation, observedAt])
      .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.slice(0, 12), additionalData: encoder.encode(aad) }, key, envelope.slice(12)));
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const content = value as Record<string, unknown>;
      if (Object.keys(content).sort().join(",") !== "description,observedAt,source,suggestedTitle,version"
        || content.version !== 1 || content.observedAt !== observedAt
        || !validText(content.suggestedTitle, 120) || !validText(content.description, 600)
        || (content.source !== "opencode-launch" && content.source !== "generic")) return null;
      return content as unknown as SessionContent;
    } finally { plaintext.fill(0); }
  } catch { return null; }
}
