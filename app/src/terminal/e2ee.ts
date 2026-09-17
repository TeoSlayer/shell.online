export const E2EE_ENVELOPE_VERSION = 2;
export const E2EE_PBKDF2_ITERATIONS = 600_000;
const NONCE_BYTES = 12;
const LEGACY_ENVELOPE_VERSION = 1;
const STREAM_BYTES = 8;
const SEQUENCE_BYTES = 8;
const METADATA_BYTES = 1 + 1 + STREAM_BYTES + SEQUENCE_BYTES + NONCE_BYTES;
const DIRECTION_HOST_TO_VIEWER = 1;
const DIRECTION_VIEWER_TO_HOST = 2;
const REPLAY_WINDOW = 64n;

export type EncryptionFragment =
  | { kind: "key"; key: Uint8Array<ArrayBuffer> }
  | { kind: "password"; salt: Uint8Array<ArrayBuffer>; password?: string };

export class E2EEReplayError extends Error {
  constructor(message = "Replayed or stale E2EE frame") {
    super(message);
    this.name = "E2EEReplayError";
  }
}

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

function containsASCIIControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
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
    if (decoded?.byteLength !== 16) return null;
    const candidate = values.get("password");
    const bytes = candidate === null ? 0 : new TextEncoder().encode(candidate).byteLength;
    const password = candidate !== null && bytes > 0 && bytes <= 1_024 && !containsASCIIControl(candidate)
      ? candidate
      : undefined;
    return { kind: "password", salt: decoded, password };
  }
  return null;
}

export class BrowserFrameCipher {
  private readonly stream = crypto.getRandomValues(new Uint8Array(STREAM_BYTES));
  private sequence = 0n;
  private sendVersion: 1 | 2 = E2EE_ENVELOPE_VERSION;
  private readonly replay = new Map<string, { max: bigint; bitmap: bigint }>();
  private readonly legacyNonces = new Set<string>();
  private readonly legacyNonceOrder: string[] = [];

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
    if (this.sendVersion === LEGACY_ENVELOPE_VERSION) return this.sealLegacy(frame);
    if (this.sequence === 0xffff_ffff_ffff_ffffn) throw new Error("E2EE frame sequence exhausted");
    this.sequence += 1n;
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const metadata = new Uint8Array(1 + 1 + STREAM_BYTES + SEQUENCE_BYTES);
    metadata[0] = E2EE_ENVELOPE_VERSION;
    metadata[1] = frameDirection(frame[0]);
    metadata.set(this.stream, 2);
    new DataView(metadata.buffer).setBigUint64(2 + STREAM_BYTES, this.sequence);
    const aad = frameAAD(frame[0], metadata);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      this.key,
      new Uint8Array(frame.subarray(1)),
    );
    const result = new Uint8Array(1 + METADATA_BYTES + ciphertext.byteLength);
    result[0] = frame[0];
    result.set(metadata, 1);
    result.set(nonce, 1 + metadata.byteLength);
    result.set(new Uint8Array(ciphertext), 1 + METADATA_BYTES);
    return result;
  }

  async open(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (frame[1] === LEGACY_ENVELOPE_VERSION) return this.openLegacy(frame);
    if (frame.byteLength < 1 + METADATA_BYTES + 16 || frame[1] !== E2EE_ENVELOPE_VERSION) {
      throw new Error("Invalid E2EE frame");
    }
    const metadata = new Uint8Array(frame.subarray(1, 1 + 1 + 1 + STREAM_BYTES + SEQUENCE_BYTES));
    if (metadata[1] !== frameDirection(frame[0])) throw new Error("Invalid E2EE frame direction");
    const stream = metadata.subarray(2, 2 + STREAM_BYTES);
    const sequence = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength)
      .getBigUint64(2 + STREAM_BYTES);
    if (sequence === 0n) throw new Error("Invalid E2EE frame sequence");
    const aad = frameAAD(frame[0], metadata);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(frame.subarray(1 + 1 + 1 + STREAM_BYTES + SEQUENCE_BYTES, 1 + METADATA_BYTES)),
        additionalData: aad,
      },
      this.key,
      new Uint8Array(frame.subarray(1 + METADATA_BYTES)),
    );
    this.acceptSequence(stream, sequence);
    this.sendVersion = E2EE_ENVELOPE_VERSION;
    const result = new Uint8Array(1 + plaintext.byteLength);
    result[0] = frame[0];
    result.set(new Uint8Array(plaintext), 1);
    return result;
  }

  private async sealLegacy(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const aad = new Uint8Array([frame[0]]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      this.key,
      new Uint8Array(frame.subarray(1)),
    );
    const result = new Uint8Array(1 + 1 + NONCE_BYTES + ciphertext.byteLength);
    result[0] = frame[0];
    result[1] = LEGACY_ENVELOPE_VERSION;
    result.set(nonce, 2);
    result.set(new Uint8Array(ciphertext), 2 + NONCE_BYTES);
    return result;
  }

  private async openLegacy(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (frame.byteLength < 30) throw new Error("Invalid E2EE frame");
    const nonce = new Uint8Array(frame.subarray(2, 2 + NONCE_BYTES));
    const nonceKey = Array.from(nonce, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (this.legacyNonces.has(nonceKey)) throw new E2EEReplayError("Replayed E2EE frame");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: new Uint8Array([frame[0]]) },
      this.key,
      new Uint8Array(frame.subarray(2 + NONCE_BYTES)),
    );
    if (this.legacyNonceOrder.length >= 4_096) {
      const oldest = this.legacyNonceOrder.shift();
      if (oldest) this.legacyNonces.delete(oldest);
    }
    this.legacyNonces.add(nonceKey);
    this.legacyNonceOrder.push(nonceKey);
    this.sendVersion = LEGACY_ENVELOPE_VERSION;
    const result = new Uint8Array(1 + plaintext.byteLength);
    result[0] = frame[0];
    result.set(new Uint8Array(plaintext), 1);
    return result;
  }

  private acceptSequence(stream: Uint8Array, sequence: bigint): void {
    const key = Array.from(stream, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const current = this.replay.get(key) ?? { max: 0n, bitmap: 0n };
    if (sequence > current.max) {
      const shift = sequence - current.max;
      current.bitmap = shift >= REPLAY_WINDOW
        ? 1n
        : ((current.bitmap << shift) | 1n) & 0xffff_ffff_ffff_ffffn;
      current.max = sequence;
      this.replay.set(key, current);
      return;
    }
    const delta = current.max - sequence;
    if (delta >= REPLAY_WINDOW || (current.bitmap & (1n << delta)) !== 0n) {
      throw new E2EEReplayError();
    }
    current.bitmap |= 1n << delta;
    this.replay.set(key, current);
  }
}

function frameDirection(opcode: number): number {
  if ([0x01, 0x03, 0x05, 0x07, 0x08, 0x0b].includes(opcode)) return DIRECTION_HOST_TO_VIEWER;
  if ([0x02, 0x04, 0x06, 0x09, 0x0a].includes(opcode)) return DIRECTION_VIEWER_TO_HOST;
  throw new Error(`Unsupported E2EE frame opcode 0x${opcode.toString(16).padStart(2, "0")}`);
}

function frameAAD(opcode: number, metadata: Uint8Array): Uint8Array<ArrayBuffer> {
  const aad: Uint8Array<ArrayBuffer> = new Uint8Array(1 + metadata.byteLength);
  aad[0] = opcode;
  aad.set(metadata, 1);
  return aad;
}
