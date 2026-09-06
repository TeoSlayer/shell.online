import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store, CliToken } from "./store";
import { base64url } from "./pkce";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;

export function mintSecret(prefix: string): string {
  return `${prefix}_${base64url(randomBytes(32))}`;
}

/* Only the hash is persisted, so a leaked store file does not yield live tokens. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function issueTokens(
  store: Store,
  identity: { uid: string; email: string; name: string; label: string },
  now = Date.now(),
): IssuedTokens {
  const accessToken = mintSecret("sha");
  const refreshToken = mintSecret("shr");
  store.putToken({
    accessHash: hashSecret(accessToken),
    refreshHash: hashSecret(refreshToken),
    uid: identity.uid,
    email: identity.email,
    name: identity.name,
    label: identity.label,
    accessExpiresAt: now + ACCESS_TTL_MS,
    createdAt: now,
  });
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000) };
}

export type AccessCheck =
  | { ok: true; token: CliToken }
  | { ok: false; reason: "unknown" | "revoked" | "expired" };

export function checkAccessToken(store: Store, presented: string, now = Date.now()): AccessCheck {
  const token = store.findByAccessHash(hashSecret(presented));
  if (!token) return { ok: false, reason: "unknown" };
  if (token.revokedAt) return { ok: false, reason: "revoked" };
  if (token.accessExpiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, token };
}

export type RefreshResult =
  | { ok: true; accessToken: string; expiresIn: number; token: CliToken }
  | { ok: false; reason: "unknown" | "revoked" };

export function refreshAccessToken(
  store: Store,
  presented: string,
  now = Date.now(),
): RefreshResult {
  const token = store.findByRefreshHash(hashSecret(presented));
  if (!token) return { ok: false, reason: "unknown" };
  if (token.revokedAt) return { ok: false, reason: "revoked" };
  const accessToken = mintSecret("sha");
  store.updateToken(token.refreshHash, {
    accessHash: hashSecret(accessToken),
    accessExpiresAt: now + ACCESS_TTL_MS,
  });
  return { ok: true, accessToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), token };
}

export function revokeByRefreshToken(store: Store, presented: string, now = Date.now()): boolean {
  const token = store.findByRefreshHash(hashSecret(presented));
  if (!token || token.revokedAt) return false;
  store.updateToken(token.refreshHash, { revokedAt: now });
  return true;
}
