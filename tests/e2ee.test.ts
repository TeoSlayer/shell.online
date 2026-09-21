import { describe, expect, it } from "vitest";
import { BrowserFrameCipher, parseEncryptionFragment } from "../shared/e2ee";

describe("browser E2EE envelope", () => {
  it("parses keys and salts only at their exact lengths", () => {
    expect(parseEncryptionFragment(`#key=${"AA".repeat(16)}`)).toBeNull();
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const key = encode(new Uint8Array(32).fill(7));
    expect(parseEncryptionFragment(`#key=${key}`)?.kind).toBe("key");
    const salt = encode(new Uint8Array(16).fill(9));
    expect(parseEncryptionFragment(`#salt=${salt}`)?.kind).toBe("password");
    expect(parseEncryptionFragment(`#salt=${salt}&password=Ab3dE7-_`)).toMatchObject({
      kind: "password",
      password: "Ab3dE7-_",
    });
    expect(parseEncryptionFragment(`#salt=${salt}&password=`)).toMatchObject({
      kind: "password",
      password: undefined,
    });
  });

  it("round-trips frames and rejects tampering", async () => {
    const cipher = await BrowserFrameCipher.fromKey(new Uint8Array(32).fill(3));
    const frame = new Uint8Array([1, ...new TextEncoder().encode("terminal secret")]);
    const sealed = await cipher.seal(frame);
    expect(new TextDecoder().decode(sealed)).not.toContain("terminal secret");
    expect(await cipher.open(sealed)).toEqual(frame);
    const opcodeTamper = new Uint8Array(sealed);
    opcodeTamper[0] ^= 1;
    await expect(cipher.open(opcodeTamper)).rejects.toThrow();
    sealed[sealed.length - 1] ^= 1;
    await expect(cipher.open(sealed)).rejects.toThrow();
  });

  it("rejects replayed frames while allowing a small reordering window", async () => {
    const cipher = await BrowserFrameCipher.fromKey(new Uint8Array(32).fill(5));
    const frames = await Promise.all(["a", "b", "c"].map((value) =>
      cipher.seal(new Uint8Array([2, value.charCodeAt(0)]))));
    await expect(cipher.open(frames[2])).resolves.toEqual(new Uint8Array([2, 99]));
    await expect(cipher.open(frames[0])).resolves.toEqual(new Uint8Array([2, 97]));
    await expect(cipher.open(frames[1])).resolves.toEqual(new Uint8Array([2, 98]));
    await expect(cipher.open(frames[1])).rejects.toThrow(/replayed/i);
  });

  it("opens the Go AES-GCM compatibility vector", async () => {
    const cipher = await BrowserFrameCipher.fromKey(Uint8Array.from({ length: 32 }, (_, index) => index));
    const hex = "0101000102030405060708090a0b2f67ba77aabc5ea34e96d1ce6b9479978b53be0144";
    const sealed = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
    expect(new TextDecoder().decode((await cipher.open(sealed)).subarray(1))).toBe("hello");
  });

  it("opens the sequenced Go envelope-v2 compatibility vector", async () => {
    const cipher = await BrowserFrameCipher.fromKey(Uint8Array.from({ length: 32 }, (_, index) => index));
    const hex = "01020100010203040506070000000000000001000102030405060708090a0b2f67ba77aaca8b8b050124ea94b7b8803644a14b0b";
    const sealed = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
    expect(new TextDecoder().decode((await cipher.open(sealed)).subarray(1))).toBe("hello");
    await expect(cipher.open(sealed)).rejects.toThrow(/replayed/i);
  });

  it("derives the same password key as Go", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
    const cipher = await BrowserFrameCipher.fromPassword("test password", salt);
    const hex = "0101000102030405060708090a0bcb9e2ff7668a414711dc8bafbf9702882a922539e3";
    const sealed = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
    expect(new TextDecoder().decode((await cipher.open(sealed)).subarray(1))).toBe("hello");
  });
});
