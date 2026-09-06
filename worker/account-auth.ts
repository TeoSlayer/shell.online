/**
 * Optional accounts: password hashing and signed session cookies.
 *
 * Deliberately mirrors worker/stats-auth.ts so both auth surfaces behave the
 * same way. Accounts are never required to create, open, or use a share.
 */
const COOKIE_NAME = "shell_account_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_VERSION = "a1";
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export const ACCOUNT_COOKIE_NAME = COOKIE_NAME;

interface AccountSessionPayload {
  accountId: string;
  issuedAt: number;
  expiresAt: number;
}

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PBKDF2-HMAC-SHA256, per-account salt. Returns salt and hash as base64url. */
export async function hashPassword(
  password: string,
  existingSalt?: string,
): Promise<{ salt: string; hash: string }> {
  const salt: Uint8Array<ArrayBuffer> = existingSalt
    ? decodeBase64Url(existingSalt)
    : crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)));
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    KEY_BYTES * 8,
  );
  return { salt: encodeBase64Url(salt), hash: encodeBase64Url(new Uint8Array(bits)) };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const { hash } = await hashPassword(password, salt);
    return constantTimeEqual(decodeBase64Url(hash), decodeBase64Url(expectedHash));
  } catch {
    return false;
  }
}

async function sign(message: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function createAccountSession(
  accountId: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload: AccountSessionPayload = {
    accountId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1_000,
  };
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const message = `${TOKEN_VERSION}.${encoded}`;
  return `${message}.${encodeBase64Url(await sign(message, secret))}`;
}

/** Returns the account id when the cookie is authentic and unexpired. */
export async function readAccountSession(
  token: string | null,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  if (!token || secret.length < 12 || token.length > 2_048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  let payload: AccountSessionPayload;
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(parts[2]);
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]))) as AccountSessionPayload;
  } catch {
    return null;
  }
  const expected = await sign(`${parts[0]}.${parts[1]}`, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  if (typeof payload.accountId !== "string" || !payload.accountId) return null;
  if (typeof payload.expiresAt !== "number" || now >= payload.expiresAt) return null;
  return payload.accountId;
}

export function accountCookie(token: string, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearedAccountCookie(secure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < 8 || value.length > 256) return null;
  return value;
}
