import type { Message } from "./transcript";

/**
 * The conversation, kept on the device that watched it.
 *
 * A session's transcript is built by reading the screen: reload the page and
 * the renderer starts from whatever the relay replays, which is the screen and
 * not the conversation. Everything said before that was gone.
 *
 * It is kept in the browser rather than on the server, and deliberately. The
 * relay cannot read a session -- that is the product -- so a server-side
 * history would mean shipping the conversation somewhere it is not supposed to
 * exist, or encrypting it client-side and storing ciphertext nobody can
 * operate on. The device that watched already has the plaintext on screen, so
 * it is the honest place to keep it, and it makes the rule easy to say: a
 * device remembers what it was there for, and says so when it was not.
 *
 * IndexedDB rather than `localStorage`, for two reasons that both matter here:
 * `localStorage` is synchronous, so every write would land on the thread that
 * draws the conversation, which is the thread this renderer has spent a long
 * time keeping free; and it caps out around 5MB, which a day's session passes
 * without trying.
 *
 * At rest it is encrypted whenever the session is. The key comes from the
 * session's own encryption fragment -- the secret in the share link -- so a
 * cached conversation is readable by exactly the people who could read the
 * session it came from, and no one else with access to the disk. A session
 * with no encryption has nothing to derive from and is stored as it is, which
 * is no worse than the session itself.
 */

const DATABASE = "shell-chat-history";
const STORE = "transcripts";
const VERSION = 1;

/** Past this, the oldest are dropped; the transcript itself trims at 500. */
const KEPT = 400;

/** How long after the last change to write, so a burst is one write. */
const SETTLE_MS = 1200;

interface Stored {
  sessionId: string;
  savedAt: number;
  /** The plaintext JSON, when the session carries no secret to lock it with. */
  plain?: string;
  /** AES-GCM over the same JSON, when it does. */
  sealed?: ArrayBuffer;
  iv?: Uint8Array<ArrayBuffer>;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "sessionId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(store: IDBObjectStore, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    void store;
  });
}

/**
 * A key for this session's cache, from the secret that already protects it.
 *
 * HKDF with a label of its own, so the cache key is not the session key: the
 * same secret used twice for two purposes is how one of them ends up
 * weakening the other.
 */
async function cacheKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("shell.online/chat-history"),
      info: new TextEncoder().encode("transcript-at-rest"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export class ChatHistory {
  private readonly sessionId: string;
  private readonly secret: string | null;
  private key: Promise<CryptoKey> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: readonly Message[] | null = null;
  private disposed = false;

  constructor(sessionId: string, secret: string | null) {
    this.sessionId = sessionId;
    this.secret = secret && secret.length > 0 ? secret : null;
    if (this.secret) this.key = cacheKey(this.secret);
  }

  /** Whether this browser can keep a history at all. */
  static available(): boolean {
    return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
  }

  /**
   * What this device remembers of this session, or null if it was not here.
   *
   * Null is a real answer and the caller says so out loud: a conversation that
   * quietly starts halfway through looks like one that lost its beginning.
   */
  async load(): Promise<Message[] | null> {
    if (!ChatHistory.available()) return null;
    try {
      const db = await database();
      const transaction = db.transaction(STORE, "readonly");
      const store = transaction.objectStore(STORE);
      const row = await run(store, store.get(this.sessionId) as IDBRequest<Stored | undefined>);
      db.close();
      if (!row) return null;
      const json = row.plain ?? (await this.unseal(row));
      if (!json) return null;
      const messages = JSON.parse(json) as Message[];
      return Array.isArray(messages) ? messages : null;
    } catch {
      /* A cache that cannot be read is a cache that was not there. */
      return null;
    }
  }

  /**
   * Keeps what is on screen, once the screen stops changing.
   *
   * Called on every change, which during an answer is many times a second.
   * Writing each of them would be writing the same conversation over and over
   * for the sake of its last line, so the write waits for the burst to end.
   */
  save(messages: readonly Message[]): void {
    if (this.disposed || !ChatHistory.available()) return;
    this.pending = messages;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const held = this.pending;
      this.pending = null;
      if (held) void this.write(held);
    }, SETTLE_MS);
  }

  /** Writes now rather than on the timer; for a page that is going away. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const held = this.pending;
    this.pending = null;
    if (held) await this.write(held);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async write(messages: readonly Message[]): Promise<void> {
    try {
      /* Closed messages only: one still being written is not history yet. */
      const kept = messages.filter((message) => !message.open).slice(-KEPT);
      const json = JSON.stringify(kept);
      const row: Stored = { sessionId: this.sessionId, savedAt: Date.now() };
      if (this.key) {
        const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
        row.iv = iv;
        row.sealed = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          await this.key,
          new TextEncoder().encode(json),
        );
      } else {
        row.plain = json;
      }
      const db = await database();
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      await run(store, store.put(row) as unknown as IDBRequest<IDBValidKey>);
      db.close();
    } catch {
      /* Out of quota, private window, disabled storage: the session goes on. */
    }
  }

  private async unseal(row: Stored): Promise<string | null> {
    if (!row.sealed || !row.iv || !this.key) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.iv }, await this.key, row.sealed);
      return new TextDecoder().decode(plain);
    } catch {
      /* A different link to the same session cannot read this one's cache. */
      return null;
    }
  }
}
