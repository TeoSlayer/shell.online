const COOKIE_NAME = "shell_stats_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_MS = 60_000;
const TOKEN_VERSION = "v1";

interface SessionPayload {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export async function verifyStatsPassword(
  suppliedPassword: string,
  configuredPassword: string,
): Promise<boolean> {
  if (
    configuredPassword.length < 12 ||
    suppliedPassword.length === 0 ||
    suppliedPassword.length > 256
  ) {
    return false;
  }

  const [suppliedDigest, configuredDigest] = await Promise.all([
    sha256(suppliedPassword),
    sha256(configuredPassword),
  ]);
  return constantTimeBytesEqual(suppliedDigest, configuredDigest);
}

export async function createStatsSession(
  configuredPassword: string,
  now = Date.now(),
): Promise<string> {
  const payload: SessionPayload = {
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1_000,
    nonce: randomToken(16),
  };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const message = `${TOKEN_VERSION}.${encodedPayload}`;
  const signature = await sign(message, configuredPassword);
  return `${message}.${encodeBase64Url(signature)}`;
}

export async function verifyStatsSession(
  token: string | null,
  configuredPassword: string,
  now = Date.now(),
): Promise<boolean> {
  if (!token || configuredPassword.length < 12 || token.length > 1_024) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;

  let signature: Uint8Array;
  let payload: SessionPayload;
  try {
    signature = decodeBase64Url(parts[2]);
    const decodedPayload = new TextDecoder().decode(decodeBase64Url(parts[1]));
    payload = JSON.parse(decodedPayload) as SessionPayload;
  } catch {
    return false;
  }

  const signatureValid = await verifySignature(
    `${parts[0]}.${parts[1]}`,
    signature,
    configuredPassword,
  );
  if (!signatureValid) return false;

  return Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) &&
    typeof payload.nonce === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(payload.nonce) &&
    payload.issuedAt <= now + MAX_CLOCK_SKEW_MS &&
    payload.expiresAt > now &&
    payload.expiresAt - payload.issuedAt === SESSION_TTL_SECONDS * 1_000;
}

export function readStatsSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== COOKIE_NAME) continue;
    const value = entry.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

export function createStatsSessionCookie(token: string, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearStatsSessionCookie(secure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

async function sign(message: string, secret: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return new Uint8Array(signature);
}

async function verifySignature(
  message: string,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  if (signature.length !== 32) return false;
  const key = await importHmacKey(secret, ["verify"]);
  const signatureCopy = new Uint8Array(signature);
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureCopy,
    new TextEncoder().encode(message),
  );
}

function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`shell.online stats\0${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function randomToken(byteCount: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
