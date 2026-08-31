export const E2EE_ENVELOPE_VERSION = 1;
export const E2EE_PBKDF2_ITERATIONS = 600_000;
const NONCE_BYTES = 12;

export type EncryptionFragment =
  | { kind: "key"; key: Uint8Array<ArrayBuffer> }
  | { kind: "password"; salt: Uint8Array<ArrayBuffer> };

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function parseEncryptionFragment(hash: string): EncryptionFragment | null {
  const values = new URLSearchParams(hash.replace(/^#/, ""));
  const key = values.get("key");
  if (key) {
    const decoded = decodeBase64Url(key);
    return decoded?.byteLength === 32 ? { kind: "key", key: decoded } : null;
  }
  const salt = values.get("salt");
  if (salt) {
    const decoded = decodeBase64Url(salt);
    return decoded?.byteLength === 16 ? { kind: "password", salt: decoded } : null;
  }
  return null;
}

export class BrowserFrameCipher {
  private constructor(private readonly key: CryptoKey) {}

  static async fromKey(key: Uint8Array<ArrayBuffer>): Promise<BrowserFrameCipher> {
    const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
    return new BrowserFrameCipher(imported);
  }

  static async fromPassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<BrowserFrameCipher> {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: E2EE_PBKDF2_ITERATIONS },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return new BrowserFrameCipher(key);
  }

  async seal(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (frame.byteLength === 0) throw new Error("Empty E2EE frame");
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const aad = new Uint8Array([frame[0]]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      this.key,
      new Uint8Array(frame.subarray(1)),
    );
    const result = new Uint8Array(1 + 1 + NONCE_BYTES + ciphertext.byteLength);
    result[0] = frame[0];
    result[1] = E2EE_ENVELOPE_VERSION;
    result.set(nonce, 2);
    result.set(new Uint8Array(ciphertext), 2 + NONCE_BYTES);
    return result;
  }

  async open(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (frame.byteLength < 30 || frame[1] !== E2EE_ENVELOPE_VERSION) {
      throw new Error("Invalid E2EE frame");
    }
    const aad = new Uint8Array([frame[0]]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(frame.subarray(2, 14)), additionalData: aad },
      this.key,
      new Uint8Array(frame.subarray(14)),
    );
    const result = new Uint8Array(1 + plaintext.byteLength);
    result[0] = frame[0];
    result.set(new Uint8Array(plaintext), 1);
    return result;
  }
}
