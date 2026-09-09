import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * These tests are the end-to-end claim.
 *
 * The service stores a session password only as ciphertext sealed to a
 * member's browser key, and the claim is that nobody else can open it. That
 * claim rested on code with no tests at all until this file existed, which is
 * a poor place for it to rest: the failure mode of sealing is silent, and a
 * mistake here reads as "sharing works" right up until the wrong person can
 * read a password.
 *
 * Each test names the property it is holding, not the function it is calling.
 */

/* A browser is a localStorage. Swapping it is how a second browser is made. */
function browser() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

let current = browser();

vi.stubGlobal("window", {
  get localStorage() {
    return current;
  },
});

async function freshBrowser() {
  current = browser();
  vi.resetModules();
  return import("./keypair");
}

/*
 * The envelope is a nonce followed by ciphertext, base64url with no padding.
 * A test that tampers has to reach the bytes, so it decodes rather than
 * editing the text; see the tampering test for what goes wrong otherwise.
 */
const NONCE_BYTES = 12;

function decode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[index] ^= 0x01;
  return copy;
}

describe("sealing a session password", () => {
  beforeEach(() => {
    current = browser();
    vi.resetModules();
  });

  /*
   * The round trip itself is in the "opening" block below, where both browsers
   * are held properly. What this one holds is narrower and worth its own name:
   * the thing handed to the service is not the password.
   */
  it("hands the service an envelope, not a password", async () => {
    const recipient = await freshBrowser();
    const recipientKey = await recipient.publicKey();

    const owner = await freshBrowser();
    const [share] = await owner.sealForMembers([{ uid: "u1", publicKey: recipientKey }], "hunter2");

    expect(share.uid).toBe("u1");
    expect(share.sealed).not.toContain("hunter2");
    expect(share.senderPublicKey).not.toContain("hunter2");
    /* An ephemeral public key travels with it, and it is not the recipient's. */
    expect(share.senderPublicKey).not.toBe(recipientKey);
  });

  it("produces ciphertext that does not contain the password", async () => {
    const other = await freshBrowser();
    const key = await other.publicKey();
    const owner = await freshBrowser();
    const [share] = await owner.sealForMembers([{ uid: "u1", publicKey: key }], "correct horse");
    const decoded = atob(share.sealed.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).not.toContain("correct");
    expect(share.sealed).not.toContain("horse");
  });

  it("skips a member who has published no key rather than sealing to nothing", async () => {
    const other = await freshBrowser();
    const key = await other.publicKey();
    const owner = await freshBrowser();
    const shares = await owner.sealForMembers(
      [{ uid: "u1", publicKey: key }, { uid: "u2" }, { uid: "u3", publicKey: undefined }],
      "secret",
    );
    expect(shares.map((share) => share.uid)).toEqual(["u1"]);
  });

  /*
   * Two envelopes of the same password must not be byte-identical. If they
   * were, anyone holding the ciphertext could tell that two sessions share a
   * password without opening either.
   */
  it("never produces the same ciphertext twice for the same password", async () => {
    const other = await freshBrowser();
    const key = await other.publicKey();
    const owner = await freshBrowser();
    const first = await owner.sealForMembers([{ uid: "u1", publicKey: key }], "same");
    const second = await owner.sealForMembers([{ uid: "u1", publicKey: key }], "same");
    expect(first[0].sealed).not.toBe(second[0].sealed);
    expect(first[0].senderPublicKey).not.toBe(second[0].senderPublicKey);
  });

  it("gives each member a different envelope of the same password", async () => {
    const one = await freshBrowser();
    const oneKey = await one.publicKey();
    const two = await freshBrowser();
    const twoKey = await two.publicKey();
    const owner = await freshBrowser();
    const shares = await owner.sealForMembers(
      [{ uid: "u1", publicKey: oneKey }, { uid: "u2", publicKey: twoKey }],
      "shared",
    );
    expect(shares[0].sealed).not.toBe(shares[1].sealed);
  });
});

describe("opening a sealed password", () => {
  beforeEach(() => {
    current = browser();
    vi.resetModules();
  });

  it("returns the password to the browser it was sealed for", async () => {
    /* Recipient publishes a key. */
    const recipientStore = browser();
    current = recipientStore;
    vi.resetModules();
    const recipient = await import("./keypair");
    const recipientKey = await recipient.publicKey();

    /* Owner seals to it from a different browser. */
    current = browser();
    vi.resetModules();
    const owner = await import("./keypair");
    const [share] = await owner.sealForMembers([{ uid: "u1", publicKey: recipientKey }], "letmein");

    /* Recipient opens it. */
    current = recipientStore;
    vi.resetModules();
    const opener = await import("./keypair");
    expect(await opener.openSealed(share.senderPublicKey, share.sealed)).toBe("letmein");
  });

  it("refuses a browser it was not sealed for", async () => {
    const recipientStore = browser();
    current = recipientStore;
    vi.resetModules();
    const recipient = await import("./keypair");
    const recipientKey = await recipient.publicKey();

    current = browser();
    vi.resetModules();
    const owner = await import("./keypair");
    const [share] = await owner.sealForMembers([{ uid: "u1", publicKey: recipientKey }], "letmein");

    /* A third browser, with its own key, holding the same ciphertext. */
    current = browser();
    vi.resetModules();
    const stranger = await import("./keypair");
    expect(await stranger.openSealed(share.senderPublicKey, share.sealed)).toBeNull();
  });

  it("refuses ciphertext that has been altered", async () => {
    const recipientStore = browser();
    current = recipientStore;
    vi.resetModules();
    const recipient = await import("./keypair");
    const recipientKey = await recipient.publicKey();

    current = browser();
    vi.resetModules();
    const owner = await import("./keypair");
    const [share] = await owner.sealForMembers([{ uid: "u1", publicKey: recipientKey }], "letmein");

    /*
     * Flip a bit of the ciphertext. AES-GCM must notice.
     *
     * The flip is made in the bytes and not in the base64url text: the last
     * character of an envelope whose length is not a multiple of three carries
     * bits that decoding discards, so changing it can leave the ciphertext
     * exactly as it was. That made this test pass on most envelopes and fail
     * on the few that ended in one of those characters.
     */
    const tampered = encode(flipBit(decode(share.sealed), NONCE_BYTES));

    current = recipientStore;
    vi.resetModules();
    const opener = await import("./keypair");
    expect(await opener.openSealed(share.senderPublicKey, tampered)).toBeNull();
  });

  it("refuses an envelope presented with somebody else's sender key", async () => {
    const recipientStore = browser();
    current = recipientStore;
    vi.resetModules();
    const recipient = await import("./keypair");
    const recipientKey = await recipient.publicKey();

    current = browser();
    vi.resetModules();
    const owner = await import("./keypair");
    const [share] = await owner.sealForMembers([{ uid: "u1", publicKey: recipientKey }], "letmein");
    const [other] = await owner.sealForMembers([{ uid: "u1", publicKey: recipientKey }], "letmein");

    current = recipientStore;
    vi.resetModules();
    const opener = await import("./keypair");
    expect(await opener.openSealed(other.senderPublicKey, share.sealed)).toBeNull();
  });

  it("has nothing to open in a browser that never made a key", async () => {
    current = browser();
    vi.resetModules();
    const fresh = await import("./keypair");
    expect(await fresh.openSealed("not-a-key", "not-an-envelope")).toBeNull();
  });
});
