import { isP256PublicKey } from "./vault";

/**
 * The shapes the service accepts for the team audit key and for typed input.
 *
 * What people type into a session is recorded for their team, sealed in the
 * browser to a key the team holds and this service does not. The service can
 * only check that what it is handed looks like that, never what is inside, so
 * these checks are about shape: enough to refuse plaintext and junk.
 */

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Prefix of typed input sealed to the team's audit key. */
export const AUDIT_ENVELOPE_PREFIX = "a1.";
/** Prefix of a member's copy of the team's private audit key. */
export const TEAM_SHARE_PREFIX = "t1.";

/* An entry holds at most 4,000 characters of input; this leaves room for the envelope. */
const MAX_ENVELOPE_LENGTH = 8192;
const NONCE_AND_TAG = 12 + 16;
/* A PKCS#8 P-256 key is about 138 bytes; anything much smaller is not one. */
const SHARE_MIN_BYTES = NONCE_AND_TAG + 64;
const SHARE_MAX_BYTES = 1024;

function decodedLength(value: string): number | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  return Math.floor((value.length * 3) / 4);
}

/**
 * True for `a1.<version>.<senderPublicKey>.<nonce and ciphertext>`, the form
 * the browser seals typed input in. An empty interrupt still carries a nonce
 * and a tag, so no well-formed envelope is shorter than that.
 */
export async function isAuditEnvelope(text: unknown): Promise<boolean> {
  if (typeof text !== "string" || text.length > MAX_ENVELOPE_LENGTH) return false;
  if (!text.startsWith(AUDIT_ENVELOPE_PREFIX)) return false;
  const parts = text.slice(AUDIT_ENVELOPE_PREFIX.length).split(".");
  if (parts.length !== 3) return false;
  const [version, sender, body] = parts;
  if (!/^[1-9][0-9]{0,8}$/.test(version)) return false;
  const length = decodedLength(body);
  if (length === null || length < NONCE_AND_TAG) return false;
  return isP256PublicKey(sender);
}

/** True for `t1.<nonce and ciphertext>` of about the size a sealed private key is. */
export function isTeamKeyShare(sealed: unknown): boolean {
  if (typeof sealed !== "string" || !sealed.startsWith(TEAM_SHARE_PREFIX)) return false;
  const length = decodedLength(sealed.slice(TEAM_SHARE_PREFIX.length));
  return length !== null && length >= SHARE_MIN_BYTES && length <= SHARE_MAX_BYTES;
}
