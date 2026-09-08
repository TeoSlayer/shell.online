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
  deviceId: string;
}

/**
 * Mints CLI credentials, reusing the device row the account already has for
 * this machine when there is one.
 *
 * A login is not a new machine. Recording one every time is what leaves three
 * identical laptops in a device list, so an identity that names its machine
 * updates that row -- keeping the id the browser addresses it by and the
 * createdAt it is ordered by -- and only an unknown machine adds a row.
 *
 * Rotating the hashes retires whatever the previous login on that machine was
 * handed. That is the point rather than a side effect: a copy of the old
 * credentials, taken from a backup or left behind on a machine that changed
 * hands, stops working the moment someone signs in there again.
 */
export async function issueTokens(
  store: Store,
  identity: { uid: string; email: string; name: string; label: string; machineId?: string },
  now = Date.now(),
): Promise<IssuedTokens> {
  const accessToken = mintSecret("sha");
  const refreshToken = mintSecret("shr");

  const existing = identity.machineId
    ? await store.deviceForMachine(identity.uid, identity.machineId)
    : null;
  if (existing) {
    await store.updateToken(existing.refreshHash, {
      accessHash: hashSecret(accessToken),
      refreshHash: hashSecret(refreshToken),
      accessExpiresAt: now + ACCESS_TTL_MS,
      label: identity.label,
      lastSeenAt: now,
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
      deviceId: existing.id,
    };
  }

  const deviceId = mintSecret("dev");
  await store.putToken({
    id: deviceId,
    accessHash: hashSecret(accessToken),
    refreshHash: hashSecret(refreshToken),
    uid: identity.uid,
    email: identity.email,
    name: identity.name,
    label: identity.label,
    machineId: identity.machineId,
    accessExpiresAt: now + ACCESS_TTL_MS,
    createdAt: now,
    lastSeenAt: now,
  });
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    deviceId,
  };
}

export type AccessCheck =
  | { ok: true; token: CliToken }
  | { ok: false; reason: "unknown" | "revoked" | "expired" };

export async function checkAccessToken(store: Store, presented: string, now = Date.now()): Promise<AccessCheck> {
  const token = await store.findByAccessHash(hashSecret(presented));
  if (!token) return { ok: false, reason: "unknown" };
  if (token.revokedAt) return { ok: false, reason: "revoked" };
  if (token.accessExpiresAt <= now) return { ok: false, reason: "expired" };
  await store.touchToken(token.id, now);
  return { ok: true, token };
}

export type RefreshResult =
  | { ok: true; accessToken: string; expiresIn: number; token: CliToken }
  | { ok: false; reason: "unknown" | "revoked" };

export async function refreshAccessToken(
  store: Store,
  presented: string,
  now = Date.now(),
): Promise<RefreshResult> {
  const token = await store.findByRefreshHash(hashSecret(presented));
  if (!token) return { ok: false, reason: "unknown" };
  if (token.revokedAt) return { ok: false, reason: "revoked" };
  const accessToken = mintSecret("sha");
  await store.updateToken(token.refreshHash, {
    accessHash: hashSecret(accessToken),
    accessExpiresAt: now + ACCESS_TTL_MS,
  });
  return { ok: true, accessToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), token };
}

export async function revokeByRefreshToken(store: Store, presented: string, now = Date.now()): Promise<boolean> {
  const token = await store.findByRefreshHash(hashSecret(presented));
  if (!token || token.revokedAt) return false;
  await store.updateToken(token.refreshHash, { revokedAt: now });
  return true;
}
