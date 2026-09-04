export const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
export const PERSISTENT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function disconnectedSessionExpiry(now: number, persistent: boolean): number {
  return now + (persistent ? PERSISTENT_TTL_MS : SESSION_TTL_MS);
}
