import fixtureJSON from "../../../internal/account/testdata/session-content-v1.json?raw";
import { describe, expect, it } from "vitest";
import { openSessionContent } from "./session-content-crypto";
import { openFromAccount, sealToAccount } from "./vault-crypto";

const fixture = JSON.parse(fixtureJSON);
const context = "shell.online session content v1";
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function privateKey(publicValue = fixture.accountPublicKey, privateValue = fixture.recipientPrivateKey) {
  const publicBytes = decode(publicValue);
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: encode(publicBytes.subarray(1, 33)), y: encode(publicBytes.subarray(33)), d: privateValue }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}
async function open(share = fixture, sessionId = fixture.sessionId, uid = fixture.recipientUid, generation = fixture.generation, at = fixture.content.observedAt) {
  return openSessionContent(await privateKey(), sessionId, uid, generation, at, share);
}
// Test-only sender lets authenticated but malformed payloads exercise validation.
async function sealPayload(payload: unknown) {
  const sender = await privateKey(fixture.senderPublicKey, fixture.senderPrivateKey);
  const owner = await crypto.subtle.importKey("raw", decode(fixture.accountPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: owner }, sender, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(context) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const nonce = decode(fixture.nonce);
  const aad = encoder.encode(JSON.stringify([context, fixture.sessionId, fixture.recipientUid, fixture.generation, fixture.content.observedAt]).replace(/\u2028/g, "\\u2028"));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, encoder.encode(JSON.stringify(payload))));
  const envelope = new Uint8Array(nonce.length + ciphertext.length); envelope.set(nonce); envelope.set(ciphertext, nonce.length);
  return { senderPublicKey: fixture.senderPublicKey, sealed: "sc1." + encode(envelope) };
}

describe("owner session content", () => {
  it("opens the deterministic shared Go vector and reproduces it", async () => {
    expect(await open()).toEqual(fixture.content);
    expect((await sealPayload(fixture.content)).sealed).toBe(fixture.sealed);
  });
  it("rejects a different session, owner, generation or observation time", async () => {
    expect(await open(fixture, "different")).toBeNull();
    expect(await open(fixture, fixture.sessionId, "different")).toBeNull();
    expect(await open(fixture, fixture.sessionId, fixture.recipientUid, "different")).toBeNull();
    expect(await open(fixture, fixture.sessionId, fixture.recipientUid, fixture.generation, fixture.content.observedAt + 1)).toBeNull();
  });
  it("rejects wrong keys and tampered envelopes", async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    expect(await openSessionContent(other.privateKey, fixture.sessionId, fixture.recipientUid, fixture.generation, fixture.content.observedAt, fixture)).toBeNull();
    const bytes = decode(fixture.sealed.slice(4)); bytes[20] ^= 1;
    expect(await open({ ...fixture, sealed: "sc1." + encode(bytes) })).toBeNull();
  });
  it("domain separates content from password envelopes even after prefix substitution", async () => {
    expect(await openFromAccount(await privateKey(), fixture.sessionId, fixture.recipientUid, { senderPublicKey: fixture.senderPublicKey, sealed: "v2." + fixture.sealed.slice(4) })).toBeNull();
    const password = await sealToAccount(fixture.accountPublicKey, fixture.sessionId, fixture.recipientUid, "synthetic-password");
    expect(await open(password)).toBeNull();
    expect(await open({ ...password, sealed: "sc1." + password.sealed.slice(3) })).toBeNull();
  });
  it.each([
    null, [], {}, { ...fixture.content, extra: "field" }, { ...fixture.content, version: 2 },
    { ...fixture.content, observedAt: fixture.content.observedAt + 1 },
    { ...fixture.content, suggestedTitle: "🔒".repeat(121) }, { ...fixture.content, description: "x".repeat(601) },
    { ...fixture.content, suggestedTitle: "escape\u001b" }, { ...fixture.content, description: "bidi\u202e" },
    { ...fixture.content, description: "surrogate\ud800" }, { ...fixture.content, source: "reasoning" },
    { ...fixture.content, description: 42 },
  ])("rejects malformed authenticated content %#", async (payload) => { expect(await open(await sealPayload(payload))).toBeNull(); });
  it("accepts Unicode at the exact rune caps", async () => {
    const payload = { ...fixture.content, suggestedTitle: "🔒".repeat(120), description: "é".repeat(600), source: "generic" };
    expect(await open(await sealPayload(payload))).toEqual(payload);
  });
  it("preserves Markdown newlines and tabs only in descriptions", async () => {
    const payload = {...fixture.content, description: "## Heading\n\n- first\n\tcode"};
    expect(await open(await sealPayload(payload))).toEqual(payload);
    expect(await open(await sealPayload({...fixture.content, suggestedTitle: "bad\ntitle"}))).toBeNull();
    expect(await open(await sealPayload({...fixture.content, description: "bad\u001bcontrol"}))).toBeNull();
  });
  it("rejects malformed and oversized outer values", async () => {
    for (const sealed of ["", "sc1.AA", "sc1." + "A".repeat(8192), fixture.sealed + "=", "v2." + fixture.sealed.slice(4)]) expect(await open({ ...fixture, sealed })).toBeNull();
    expect(await open({ ...fixture, senderPublicKey: "invalid" })).toBeNull();
    expect(await open(fixture, "")).toBeNull();
    expect(await open(fixture, fixture.sessionId, fixture.recipientUid, fixture.generation, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
