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

/** The unlocked vault for this account, or null when this browser has none. */
export async function loadLocalVault(uid: string): Promise<LocalVault | null> {
  try {
    const found = await run("readonly", (store) => store.get(uid));
    return isLocalVault(found) && found.uid === uid ? found : null;
  } catch {
    /* Private windows and blocked storage: the vault asks again next visit. */
    return null;
  }
}

/** Keeps the unlocked vault. False when this browser cannot keep it. */
export async function saveLocalVault(vault: LocalVault): Promise<boolean> {
  try {
    await run("readwrite", (store) => store.put(vault));
    return true;
  } catch {
    return false;
  }
}

/** Locks the vault in this browser. The vault itself is untouched. */
export async function clearLocalVault(uid: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(uid));
  } catch {
    /* nothing kept, nothing to clear */
  }
}
