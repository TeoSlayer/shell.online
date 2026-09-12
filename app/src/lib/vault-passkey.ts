import {
  addVaultPasskeyWrap,
  openVaultWithPasskeySecret,
  vaultUnlockMethods,
  type OpenedVault,
  type VaultBundle,
} from "./vault-crypto";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

type PrfInput = AuthenticationExtensionsClientInputs & {
  prf?: {
    eval?: { first: BufferSource };
    evalByCredential?: Record<string, { first: BufferSource }>;
  };
};

type PrfOutput = AuthenticationExtensionsClientOutputs & {
  prf?: { results?: { first?: ArrayBuffer } };
};

function secretOf(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const first = (credential.getClientExtensionResults() as PrfOutput).prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

function supported(): void {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("Passkeys are not supported by this browser.");
  }
}

export async function registerVaultPasskey(
  uid: string,
  accountName: string,
  bundle: VaultBundle,
  password: string,
  label = "Passkey",
): Promise<string> {
  supported();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const userId = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid)));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "shell.online" },
      user: { id: userId, name: accountName, displayName: accountName },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: 60_000,
      attestation: "none",
      extensions: { prf: { eval: { first: salt } } } as PrfInput,
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey setup was cancelled.");
  const secret = secretOf(credential);
  if (!secret) {
    throw new Error("This passkey cannot unlock encrypted data. Try another device or use your vault password.");
  }
  try {
    return await addVaultPasskeyWrap(
      uid,
      bundle,
      password,
      toBase64Url(new Uint8Array(credential.rawId)),
      salt,
      secret,
      label,
    );
  } finally {
    secret.fill(0);
  }
}

export async function unlockVaultWithPasskey(uid: string, bundle: VaultBundle): Promise<OpenedVault> {
  supported();
  const passkeys = vaultUnlockMethods(bundle).passkeys;
  if (passkeys.length === 0) throw new Error("This vault has no passkey yet.");
  const evalByCredential = Object.fromEntries(
    passkeys.map((entry) => [entry.id, { first: fromBase64Url(entry.salt) }]),
  );
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: passkeys.map((entry) => ({ type: "public-key", id: fromBase64Url(entry.id) })),
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { evalByCredential } } as PrfInput,
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey unlock was cancelled.");
  const secret = secretOf(credential);
  if (!secret) throw new Error("That passkey cannot unlock encrypted data in this browser.");
  try {
    return await openVaultWithPasskeySecret(
      uid,
      bundle,
      toBase64Url(new Uint8Array(credential.rawId)),
      secret,
    );
  } finally {
    secret.fill(0);
  }
}
