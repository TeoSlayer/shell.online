import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isP256PublicKey, readOwnerShare, readVaultInput } from "./vault";
import { createVault, openFromAccount, sealToAccount } from "../../src/lib/vault-crypto";

/*
 * The service cannot open a vault, so all it can hold the line on is shape.
 * These tests feed it exactly what the browser makes, so a change on either
 * side that the other would reject fails here rather than at sign-up.
 */

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function browserVault() {
  const made = await createVault("uid-1");
  return {
    public_key: made.bundle.publicKey,
    encrypted_private_key: made.bundle.encryptedPrivateKey,
    recovery_wrap: made.bundle.recoveryWrap,
  };
}

describe("a vault the service is handed", () => {
  it("accepts what the browser makes", async () => {
    const body = await browserVault();
    const result = await readVaultInput(body);
    expect(result).toMatchObject({ ok: true, value: { publicKey: body.public_key } });
  });

  it("refuses a public key that is not a point on the curve", async () => {
    const body = await browserVault();
    const offCurve = new Uint8Array(65);
    offCurve[0] = 0x04;
    offCurve[64] = 0x07;
    expect(await isP256PublicKey(encode(offCurve))).toBe(false);
    expect(await readVaultInput({ ...body, public_key: encode(offCurve) })).toMatchObject({ ok: false });
  });

  it("refuses fields that are not the size the browser produces", async () => {
    const body = await browserVault();
    expect(await readVaultInput({ ...body, recovery_wrap: encode(new Uint8Array(59)) })).toMatchObject({ ok: false });
    expect(await readVaultInput({ ...body, encrypted_private_key: "short" })).toMatchObject({ ok: false });
    expect(await readVaultInput({ ...body, encrypted_private_key: "not base64url!" })).toMatchObject({ ok: false });
    expect(await readVaultInput({ ...body, public_key: undefined })).toMatchObject({ ok: false });
  });

  it("refuses a replace_version that is not a version", async () => {
    const body = await browserVault();
    for (const replace_version of [0, -1, 1.5, "1", null]) {
      expect(await readVaultInput({ ...body, replace_version })).toMatchObject({ ok: false });
    }
    expect(await readVaultInput({ ...body, replace_version: 3 })).toMatchObject({
      ok: true,
      value: { replaceVersion: 3 },
    });
  });
});

describe("the CLI's own copy of a password", () => {
  it("is accepted when it is a vault share", async () => {
    const made = await createVault("uid-1");
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "Kw9eHbru");
    expect(await readOwnerShare({ sender_public_key: share.senderPublicKey, sealed: share.sealed })).toEqual(share);
  });

  it("is dropped when it is anything else", async () => {
    const made = await createVault("uid-1");
    const share = await sealToAccount(made.bundle.publicKey, "sess_1", "uid-1", "Kw9eHbru");
    expect(await readOwnerShare(undefined)).toBeNull();
    expect(await readOwnerShare("share")).toBeNull();
    /* Without the prefix it is a browser-key share, which the CLI never makes. */
    expect(await readOwnerShare({ sender_public_key: share.senderPublicKey, sealed: share.sealed.slice(3) })).toBeNull();
    expect(await readOwnerShare({ sender_public_key: "junk", sealed: share.sealed })).toBeNull();
    expect(await readOwnerShare({ sender_public_key: share.senderPublicKey, sealed: "v2." })).toBeNull();
  });
});

/*
 * The CLI seals a session's password when it registers the session, and the
 * browser opens it. The vector was sealed by the Go code with fixed inputs
 * (internal/account/vault_test.go regenerates and checks it), so the two
 * implementations cannot drift apart unnoticed. The Go tests open the
 * browser's vector in the other direction.
 */
describe("a password the CLI sealed", () => {
  it("opens in the browser", async () => {
    const vector = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../internal/account/testdata/vault-share-v2-go.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      recipient_private_key_hex: string;
      recipient_public_key: string;
      session_id: string;
      uid: string;
      password: string;
      sender_public_key: string;
      sealed: string;
    };
    const point = decode(vector.recipient_public_key);
    const scalar = Uint8Array.from(vector.recipient_private_key_hex.match(/../g)!, (pair) => parseInt(pair, 16));
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: encode(scalar),
        x: encode(point.slice(1, 33)),
        y: encode(point.slice(33, 65)),
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const opened = await openFromAccount(privateKey, vector.session_id, vector.uid, {
      senderPublicKey: vector.sender_public_key,
      sealed: vector.sealed,
    });
    expect(opened).toBe(vector.password);
  });
});
