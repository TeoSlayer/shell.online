import type { AccountKey, SessionKeyShare } from "./types";

/**
 * The shapes a session vault arrives in, checked before anything is stored.
 *
 * Nothing here can be verified cryptographically: the service holds no key
 * that opens any of it, which is the point. What it can check is that each
 * field is the size and encoding the browser produces, so the store cannot
 * fill with junk that looks like somebody's vault, and that the public key is
 * a real P-256 point, since colleagues and the CLI will seal passwords to it.
 */

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/* An uncompressed P-256 point is 65 bytes, which is 87 base64url characters. */
const PUBLIC_KEY_LENGTH = 87;
/* Nonce, a 32-byte vault key, and the GCM tag. */
const RECOVERY_WRAP_BYTES = 12 + 32 + 16;
/* Nonce, a PKCS#8 P-256 key (about 138 bytes), and the tag, with room to spare. */
const PRIVATE_KEY_MIN_BYTES = 12 + 64 + 16;
const PRIVATE_KEY_MAX_BYTES = 512;
/* A share holds a password of at most 1,024 bytes, which is what the CLI accepts. */
const SHARE_MAX_BYTES = 12 + 1024 + 16;

/** The prefix of a password sealed to an account key rather than a browser key. */
export const VAULT_SHARE_PREFIX = "v2.";

/**
 * How recently someone must have signed in to replace their vault.
 *
 * A reset puts a new key where colleagues will seal passwords, so it is the
 * one vault operation worth more than a long-lived session token. Signing in
 * again is the proof asked for.
 */
export const RESET_SIGN_IN_WINDOW_MS = 10 * 60_000;

function decodedLength(value: string): number | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  return Math.floor((value.length * 3) / 4);
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** True for a base64url P-256 public key that is really on the curve. */
export async function isP256PublicKey(value: unknown): Promise<boolean> {
  if (typeof value !== "string" || value.length !== PUBLIC_KEY_LENGTH || decodedLength(value) !== 65) {
    return false;
  }
  try {
    await crypto.subtle.importKey("raw", fromBase64Url(value), { name: "ECDH", namedCurve: "P-256" }, true, []);
    return true;
  } catch {
    return false;
  }
}

export interface VaultInput {
  publicKey: string;
  encryptedPrivateKey: string;
  recoveryWrap: string;
  /** Present when the caller means to replace the vault at this version. */
  replaceVersion?: number;
}

export type VaultInputResult = { ok: true; value: VaultInput } | { ok: false; reason: string };

export async function readVaultInput(body: Record<string, unknown>): Promise<VaultInputResult> {
  const { public_key: publicKey, encrypted_private_key: encryptedPrivateKey, recovery_wrap: recoveryWrap } = body;
  if (!(await isP256PublicKey(publicKey))) return { ok: false, reason: "invalid public key" };

  const privateLength = typeof encryptedPrivateKey === "string" ? decodedLength(encryptedPrivateKey) : null;
  if (privateLength === null || privateLength < PRIVATE_KEY_MIN_BYTES || privateLength > PRIVATE_KEY_MAX_BYTES) {
    return { ok: false, reason: "invalid encrypted private key" };
  }
  if (typeof recoveryWrap !== "string" || decodedLength(recoveryWrap) !== RECOVERY_WRAP_BYTES) {
    return { ok: false, reason: "invalid recovery wrap" };
  }

  const replace = body.replace_version;
  if (replace !== undefined && (typeof replace !== "number" || !Number.isInteger(replace) || replace < 1)) {
    return { ok: false, reason: "invalid replace_version" };
  }

  return {
    ok: true,
    value: {
      publicKey: publicKey as string,
      encryptedPrivateKey: encryptedPrivateKey as string,
      recoveryWrap,
      replaceVersion: replace as number | undefined,
    },
  };
}

/** What a browser is told about its own vault: everything, since none of it is readable without the recovery key. */
export function vaultForApi(key: AccountKey) {
  return {
    publicKey: key.publicKey,
    encryptedPrivateKey: key.encryptedPrivateKey,
    recoveryWrap: key.recoveryWrap,
    version: key.version,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

/**
 * The copy of a session password the CLI seals to its own account.
 *
 * Returns null for anything that is not shaped like one. A session must still
 * register when this is wrong, so the caller drops it rather than failing.
 */
export async function readOwnerShare(value: unknown): Promise<Omit<SessionKeyShare, "uid"> | null> {
  if (!value || typeof value !== "object") return null;
  const { sender_public_key: senderPublicKey, sealed } = value as Record<string, unknown>;
  if (!(await isP256PublicKey(senderPublicKey))) return null;
  if (typeof sealed !== "string" || !sealed.startsWith(VAULT_SHARE_PREFIX)) return null;
  const length = decodedLength(sealed.slice(VAULT_SHARE_PREFIX.length));
  if (length === null || length < 12 + 16 + 1 || length > SHARE_MAX_BYTES) return null;
  return { senderPublicKey: senderPublicKey as string, sealed };
}
