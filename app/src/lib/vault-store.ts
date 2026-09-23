/**
 * Where this browser keeps its unlocked vault.
 *
 * IndexedDB rather than localStorage, because it can hold a CryptoKey as the
 * browser's own object. The key was imported non-extractable, so script on
 * this page can use it to open a password but cannot read it out, not even
 * script that should not be here. The browser key pair this replaces sat in
 * localStorage as a readable JWK.
 *
 * Losing this costs a recovery key, not a session: the vault itself is kept
 * by the service, sealed, and this is only the unlocked copy.
 *
 * Mutations (save/clear) are serialized per-UID in a FIFO queue. A lock's
 * clear cannot overtake a newer save for the same UID, and a read awaits
 * pending mutations so it never sees a key a queued clear is about to remove.
 */

const DATABASE = "shell.online:vault";
const STORE = "vaults";

export interface LocalVault {
  uid: string;
  publicKey: string;
  /** The vault version this key belongs to, so a reset elsewhere is noticed. */
  version: number;
  privateKey: CryptoKey;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "uid" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function isLocalVault(value: unknown): value is LocalVault {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalVault>;
  return (
    typeof candidate.uid === "string" &&
    typeof candidate.publicKey === "string" &&
    typeof candidate.version === "number" &&
    candidate.privateKey instanceof CryptoKey
  );
}

/*
 * Per-UID FIFO mutation queue. Save and clear for the same UID run in the
 * order they were requested, so a lock's clear cannot overtake a newer save.
 * Reads await the tail of the queue so they never observe a key a pending
 * clear is about to remove.
 */
const queues = new Map<string, Promise<void>>();

function enqueue<T>(uid: string, mutation: () => Promise<T>): Promise<T> {
  const prev = queues.get(uid) ?? Promise.resolve();
  const next = prev.then(mutation, mutation);
  const tail = next.then(
    () => { if (queues.get(uid) === tail) queues.delete(uid); },
    () => { if (queues.get(uid) === tail) queues.delete(uid); },
  );
  queues.set(uid, tail);
  return next;
}

async function drain(uid: string): Promise<void> {
  const tail = queues.get(uid);
  if (tail) await tail;
}

/** The unlocked vault for this account, or null when this browser has none. */
export async function loadLocalVault(uid: string): Promise<LocalVault | null> {
  try {
    await drain(uid);
    const found = await run("readonly", (store) => store.get(uid));
    return isLocalVault(found) && found.uid === uid ? found : null;
  } catch {
    /* Private windows and blocked storage: the vault asks again next visit. */
    return null;
  }
}

/**
 * Keeps the unlocked vault. False when this browser cannot keep it.
 *
 * The optional `isCurrent` predicate is checked before the database opens
 * and again immediately before the write. A stale save held behind a slow
 * openDatabase() that resolves after a lock or a newer unlock must not
 * overwrite the newer valid key.
 */
export async function saveLocalVault(vault: LocalVault, isCurrent?: () => boolean): Promise<boolean> {
  return enqueue(vault.uid, async () => {
    try {
      if (isCurrent && !isCurrent()) return false;
      const database = await openDatabase();
      try {
        if (isCurrent && !isCurrent()) return false;
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE, "readwrite");
          transaction.objectStore(STORE).put(vault);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        return true;
      } finally {
        database.close();
      }
    } catch {
      return false;
    }
  });
}

/**
 * Locks the vault in this browser. The vault itself is untouched.
 *
 * The clear always runs (no admission predicate): it was authorized by the
 * lock's synchronous generation bump. Serialization ensures it cannot
 * overtake a newer save for the same UID.
 */
export async function clearLocalVault(uid: string): Promise<void> {
  await enqueue(uid, async () => {
    try {
      const database = await openDatabase();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE, "readwrite");
          transaction.objectStore(STORE).delete(uid);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    } catch {
      /* nothing kept, nothing to clear */
    }
  });
}
