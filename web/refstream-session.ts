import type {
  SessionSnapshot,
  TerminalSession,
} from "./vendor/refstream/v0.1.0-alpha.4/refstream.js";

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_AGE_MS = 4 * 60 * 60 * 1_000;
const SAVE_DELAY_MS = 750;
const STORAGE_PREFIX = "shell-online-refstream-session:";

interface StoredSession {
  version: typeof SNAPSHOT_VERSION;
  savedAt: number;
  snapshot: SessionSnapshot;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistableSession {
  readonly signal: AbortSignal;
  onChange(listener: () => void): { dispose(): void };
  snapshot(): SessionSnapshot;
  restore(snapshot: SessionSnapshot): void;
}

function storageKey(sessionKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionKey)}`;
}

function parseStoredSession(value: string, now: number): SessionSnapshot | null {
  try {
    const stored = JSON.parse(value) as Partial<StoredSession>;
    if (
      stored.version !== SNAPSHOT_VERSION ||
      typeof stored.savedAt !== "number" ||
      now - stored.savedAt < 0 ||
      now - stored.savedAt > MAX_SNAPSHOT_AGE_MS ||
      !stored.snapshot
    ) {
      return null;
    }
    return stored.snapshot;
  } catch {
    return null;
  }
}

/**
 * Keep Refstream's logical handoff state across a reload of this tab.
 *
 * The snapshot never leaves the browser and is deliberately kept in
 * sessionStorage, not localStorage. Closing the tab forgets terminal output,
 * task answers and identities. Restoring is best-effort: the relay's fresh PTY
 * snapshot remains authoritative, and Refstream marks unfinished work for
 * inspection when terminal state changes underneath it.
 */
export function bindRefstreamSessionPersistence(
  session: TerminalSession,
  sessionKey: string,
  storage: SessionStorageLike | null | undefined = undefined,
  now: () => number = Date.now,
): { dispose(): void; flush(): void } {
  const target = session as unknown as PersistableSession;
  const key = storageKey(sessionKey);
  let backing = storage;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  if (backing === undefined) {
    try {
      backing = globalThis.sessionStorage ?? null;
    } catch {
      backing = null;
    }
  }

  if (backing) {
    try {
      const saved = backing.getItem(key);
      const snapshot = saved ? parseStoredSession(saved, now()) : null;
      if (snapshot) {
        try {
          target.restore(snapshot);
        } catch {
          backing.removeItem(key);
        }
      } else if (saved) {
        backing.removeItem(key);
      }
    } catch {
      backing = null;
    }
  }

  const flush = (): void => {
    if (!backing || target.signal.aborted) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    try {
      const stored: StoredSession = {
        version: SNAPSHOT_VERSION,
        savedAt: now(),
        snapshot: target.snapshot(),
      };
      backing.setItem(key, JSON.stringify(stored));
    } catch {
      // A full or restricted browser store must never affect the terminal.
      try {
        backing.removeItem(key);
      } catch {
        // Storage may be entirely unavailable in a locked-down browser.
      }
    }
  };

  const changed = target.onChange(() => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(flush, SAVE_DELAY_MS);
  });
  const saveBeforePageExit = (): void => flush();
  globalThis.addEventListener?.("pagehide", saveBeforePageExit);

  return {
    flush,
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      changed.dispose();
      globalThis.removeEventListener?.("pagehide", saveBeforePageExit);
    },
  };
}
