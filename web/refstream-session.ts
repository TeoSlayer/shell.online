export const REFSTREAM_SESSION_STORAGE_PREFIX = "shell-online-refstream-session:";

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

interface LegacyCaches {
  sessionStorage?: StorageLike | null;
  localStorage?: StorageLike | null;
}

function purgeStorage(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  const owned: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(REFSTREAM_SESSION_STORAGE_PREFIX)) owned.push(key);
    }
  } catch {
    return;
  }
  for (const key of owned) {
    try {
      storage.removeItem(key);
    } catch {
      // A locked-down browser may refuse the removal; the live relay snapshot
      // remains the only source of terminal state.
    }
  }
}

function globalStorage(name: "sessionStorage" | "localStorage"): StorageLike | null {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove the legacy Refstream terminal/session snapshot caches.
 *
 * Those keys held terminal output, command history and task state, which may
 * include sensitive or credential-like text. The removal is namespace-only:
 * only keys with the exact owned prefix are removed, nothing is restored first,
 * nothing is logged, and separate password, vault, and auth records are
 * untouched. The live relay snapshot stays authoritative, so this runs on
 * every app and standalone startup, even when the xterm renderer is selected.
 */
export function purgeLegacyRefstreamSessionCaches(caches: LegacyCaches = {}): void {
  purgeStorage(caches.sessionStorage ?? globalStorage("sessionStorage"));
  purgeStorage(caches.localStorage ?? globalStorage("localStorage"));
}
