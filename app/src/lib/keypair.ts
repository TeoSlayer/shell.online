/**
 * This browser's key pair, from before the session vault.
 *
 * Kept only to open passwords a colleague sealed to this browser before the
 * vault existed. Nothing new is sealed to it and it is no longer published:
 * shares now go to the account's vault key (see vault-crypto.ts), which every
 * browser the person unlocks can open. Each old share is resealed to the vault
 * the first time it opens a session here.
 *
 * What follows describes how it worked.
 *
 * A session's password is chosen by whoever starts it. For anyone else in the
 * team to open that session, the password has to reach them without
 * the accounts service being able to read it. So every browser publishes an
 * ECDH public key with its membership, and a session password is sealed once
 * per member.
 *
 * The private key lives in this browser only. Signing in elsewhere produces a
 * different key, which is why sharing is re-done rather than assumed.
 */

const STORAGE_KEY = "shell.online:keypair:v1";

interface StoredKeypair {
  publicKey: string;
  privateKey: JsonWebKey;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function read(): StoredKeypair | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredKeypair) : null;
  } catch {
    return null;
  }
}

/** Creates the key pair on first use and reuses it after. */
export async function ensureKeypair(): Promise<StoredKeypair> {
  const existing = read();
  if (existing) return existing;

  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const stored: StoredKeypair = {
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* A private window cannot keep one; sharing will not reach this browser. */
  }
  return stored;
}

export async function publicKey(): Promise<string> {
  return (await ensureKeypair()).publicKey;
}

const SEAL_INFO = "shell.online session password v1";
const NONCE_BYTES = 12;

async function deriveKey(
  privateKey: CryptoKey,
  otherPublicKey: string,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  const other = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(otherPublicKey) as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: other }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(SEAL_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

export interface SealedForMember {
  uid: string;
  senderPublicKey: string;
  sealed: string;
}

/** Seals a password so each listed member, and only they, can open it. */
export async function sealForMembers(
  members: { uid: string; publicKey?: string }[],
  password: string,
): Promise<SealedForMember[]> {
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const senderPublicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
  );

  const sealed: SealedForMember[] = [];
  for (const member of members) {
    if (!member.publicKey) continue;
    const key = await deriveKey(ephemeral.privateKey, member.publicKey, ["encrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        key,
        new TextEncoder().encode(password),
      ),
    );
    const envelope = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
    envelope.set(nonce, 0);
    envelope.set(ciphertext, nonce.byteLength);
    sealed.push({ uid: member.uid, senderPublicKey, sealed: toBase64Url(envelope) });
  }
  return sealed;
}

/** Opens a password sealed to this browser's key. */
export async function openSealed(senderPublicKey: string, sealed: string): Promise<string | null> {
  const stored = read();
  if (!stored) return null;
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      stored.privateKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const key = await deriveKey(privateKey, senderPublicKey, ["decrypt"]);
    const envelope = fromBase64Url(sealed);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: envelope.slice(0, NONCE_BYTES) as BufferSource },
      key,
      envelope.slice(NONCE_BYTES) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    /* Sealed to a different browser, or tampered with. */
    return null;
  }
}
