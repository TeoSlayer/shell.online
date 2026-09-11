import { describe, expect, it } from "vitest";
import {
  createVault,
  fingerprint,
  formatRecoveryKey,
  isVaultShare,
  openFromAccount,
  openVault,
  parseRecoveryKey,
  sealToAccount,
  VaultError,
} from "./vault-crypto";

/*
 * These tests are the vault's claim: that a password sealed to an account can
 * be opened by that account in any browser holding its recovery key, and by
 * nothing the service holds. Each names the property it keeps.
 *
 * That the CLI and this code agree on the share format is held by
 * server/lib/vault.test.ts, which can read the Go test vector from disk.
 */

function decode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* Flips a bit in the bytes, not the text; see keypair.test.ts for why. */
function tamper(envelope: string, index: number): string {
  const bytes = decode(envelope);
  bytes[index] ^= 0x01;
  return encode(bytes);
}

describe("recovery keys", () => {
  it("are eight groups of four from an alphabet with nothing that reads as something else", () => {
    const text = formatRecoveryKey(crypto.getRandomValues(new Uint8Array(20)));
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("read back to the same bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(parseRecoveryKey(formatRecoveryKey(bytes))).toEqual(bytes);
  });

  it("forgive the ways a person types one back", () => {
    const bytes = new Uint8Array(20).fill(0);
    bytes[19] = 1;
    const text = formatRecoveryKey(bytes);
    expect(text).toBe("0000-0000-0000-0000-0000-0000-0000-0001");
    const typed = "oooo oooo OOOO-0000 0000 0000 0000 000l";
    expect(parseRecoveryKey(typed)).toEqual(bytes);
    expect(parseRecoveryKey(text.toLowerCase().replace(/-/g, ""))).toEqual(bytes);
  });

  it("refuse anything that is not one", () => {
    expect(parseRecoveryKey("")).toBeNull();
    expect(parseRecoveryKey("0000-0000")).toBeNull();
    expect(parseRecoveryKey("UUUU-0000-0000-0000-0000-0000-0000-0000")).toBeNull();
  });
});

describe("a vault", () => {
  it("opens with its recovery key and yields the same key pair", async () => {
    const made = await createVault("uid-1");
    const opened = await openVault("uid-1", made.bundle, parseRecoveryKey(made.recoveryKey)!);
    expect(opened.publicKey).toBe(made.bundle.publicKey);

    /* What one sealed, the other opens: they are one key pair. */
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "Kw9eHbru");
    expect(await openFromAccount(opened.privateKey, "sess_1", "uid-1", share)).toBe("Kw9eHbru");
    expect(await openFromAccount(made.opened.privateKey, "sess_1", "uid-1", share)).toBe("Kw9eHbru");
  });

  it("keeps its private key unreadable by script once opened", async () => {
    const made = await createVault("uid-1");
    const opened = await openVault("uid-1", made.bundle, parseRecoveryKey(made.recoveryKey)!);
    expect(opened.privateKey.extractable).toBe(false);
    expect(made.opened.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", opened.privateKey)).rejects.toThrow();
  });

  it("gives the service nothing that contains the recovery key", async () => {
    const made = await createVault("uid-1");
    const stored = JSON.stringify(made.bundle);
    expect(stored).not.toContain(made.recoveryKey);
    expect(stored).not.toContain(made.recoveryKey.replace(/-/g, ""));
  });

  it("refuses the wrong recovery key", async () => {
    const made = await createVault("uid-1");
    const other = await createVault("uid-1");
    await expect(openVault("uid-1", made.bundle, parseRecoveryKey(other.recoveryKey)!)).rejects.toMatchObject({
      kind: "wrong-recovery-key",
    });
  });

  it("belongs to one account: its recovery key opens nothing under another uid", async () => {
    const made = await createVault("uid-1");
    await expect(
      openVault("uid-2", made.bundle, parseRecoveryKey(made.recoveryKey)!),
    ).rejects.toBeInstanceOf(VaultError);
  });

  /*
   * The public key is the one field the service could swap without holding a
   * secret. Sealing to a swapped key would hand it every password, so opening
   * checks the pair and refuses.
   */
  it("refuses a public key the service swapped in", async () => {
    const made = await createVault("uid-1");
    const impostor = await createVault("uid-1");
    await expect(
      openVault("uid-1", { ...made.bundle, publicKey: impostor.bundle.publicKey }, parseRecoveryKey(made.recoveryKey)!),
    ).rejects.toMatchObject({ kind: "damaged" });
  });

  it("refuses an encrypted private key that has been altered", async () => {
    const made = await createVault("uid-1");
    await expect(
      openVault(
        "uid-1",
        { ...made.bundle, encryptedPrivateKey: tamper(made.bundle.encryptedPrivateKey, 20) },
        parseRecoveryKey(made.recoveryKey)!,
      ),
    ).rejects.toMatchObject({ kind: "damaged" });
  });

  it("refuses a wrapped vault key moved into the private key's place", async () => {
    const made = await createVault("uid-1");
    await expect(
      openVault(
        "uid-1",
        { ...made.bundle, recoveryWrap: made.bundle.encryptedPrivateKey },
        parseRecoveryKey(made.recoveryKey)!,
      ),
    ).rejects.toBeInstanceOf(VaultError);
  });
});

describe("a password sealed to an account", () => {
  it("is marked as a vault share and does not contain the password", async () => {
    const made = await createVault("uid-1");
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "correct horse");
    expect(isVaultShare(share.sealed)).toBe(true);
    expect(share.sealed).not.toContain("correct");
    expect(atob(share.sealed.slice(3).replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("horse");
  });

  it("opens only for the session it was sealed for", async () => {
    const made = await createVault("uid-1");
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "pw");
    expect(await openFromAccount(made.opened.privateKey, "sess_2", "uid-1", share)).toBeNull();
  });

  it("opens only for the person it was sealed for", async () => {
    const made = await createVault("uid-1");
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "pw");
    expect(await openFromAccount(made.opened.privateKey, "sess_1", "uid-2", share)).toBeNull();
  });

  it("does not open with another account's key", async () => {
    const mine = await createVault("uid-1");
    const theirs = await createVault("uid-1");
    const share = await sealToAccount(mine.bundle.publicKey, "sess_1", "uid-1", "pw");
    expect(await openFromAccount(theirs.opened.privateKey, "sess_1", "uid-1", share)).toBeNull();
  });

  it("refuses ciphertext that has been altered", async () => {
    const made = await createVault("uid-1");
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "pw");
    const altered = { ...share, sealed: `v2.${tamper(share.sealed.slice(3), 14)}` };
    expect(await openFromAccount(made.opened.privateKey, "sess_1", "uid-1", altered)).toBeNull();
  });

  it("leaves a share from before the vault to the old browser key", async () => {
    const made = await createVault("uid-1");
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "pw");
    const legacy = { ...share, sealed: share.sealed.slice(3) };
    expect(isVaultShare(legacy.sealed)).toBe(false);
    expect(await openFromAccount(made.opened.privateKey, "sess_1", "uid-1", legacy)).toBeNull();
  });

  it("never seals the same password to the same bytes twice", async () => {
    const made = await createVault("uid-1");
    const first = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "same");
    const second = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "same");
    expect(first.sealed).not.toBe(second.sealed);
    expect(first.senderPublicKey).not.toBe(second.senderPublicKey);
  });
});

describe("fingerprints", () => {
  it("are four groups of four hex digits, stable for one key", async () => {
    const made = await createVault("uid-1");
    const print = await fingerprint(made.bundle.publicKey);
    expect(print).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(await fingerprint(made.bundle.publicKey)).toBe(print);
  });
});
