/**
 * Sealing a session password to the machine that will run it.
 *
 * The browser picks the password for a session it starts, and has to get it to
 * the machine. Sending it through the accounts service in the clear would let
 * whoever runs that service decrypt the terminal, which is the one thing the
 * end-to-end encryption is for. So the agent publishes an ephemeral ECDH
 * public key, and the browser seals to it: the service relays bytes it cannot
 * open.
 *
 * Mirrors internal/account/sealed.go.
 */

const SEAL_INFO = "shell.online cli password v1";
const NONCE_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * A browser password for a session started here: base64url from sixteen
 * random bytes.
 *
 * The CLI's own default is eight characters, a trade for someone who has to
 * type it. Nobody types this one. It travels to the machine sealed and to the
 * vault sealed, so there is no reason for it to be weaker than a key.
 */
export function generatePassword(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export interface Sealed {
  senderPublicKey: string;
  sealedPassword: string;
}

/** Seals a password to an agent's published public key. */
export async function sealPassword(
  agentPublicKey: string,
  password: string,
): Promise<Sealed> {
  const recipient = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(agentPublicKey) as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );

  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipient },
    ephemeral.privateKey,
    256,
  );

  /* HKDF-SHA256 with no salt, matching hkdf.Key(sha256, shared, nil, info). */
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(SEAL_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

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

  const senderRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );

  return {
    senderPublicKey: toBase64Url(senderRaw),
    sealedPassword: toBase64Url(envelope),
  };
}
