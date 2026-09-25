import fixtureJSON from "./testdata/session-summary-v1.json?raw";
import goFixtureJSON from "./testdata/session-summary-go-v1.json?raw";
import { describe, expect, it } from "vitest";
import { guardSummaryText, openSessionSummary } from "./session-summary-crypto";

const fixture = JSON.parse(fixtureJSON);
const SUMMARY = "shell.online session summary v1";
const CONTENT = "shell.online session content v1";
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function keyPair(publicValue: string, privateValue: string) {
  const publicBytes = decode(publicValue);
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: encode(publicBytes.subarray(1, 33)), y: encode(publicBytes.subarray(33)), d: privateValue }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}
async function open(share: { senderPublicKey: string; sealed: string } = fixture, sessionId = fixture.sessionId, uid = fixture.recipientUid, generation = fixture.generation, at = fixture.summary.observedAt) {
  return openSessionSummary(await keyPair(fixture.accountPublicKey, fixture.recipientPrivateKey), sessionId, uid, generation, at, share);
}
// Test-only sender: authenticated but hostile payloads must still be refused.
async function seal(payload: unknown, { context = SUMMARY, prefix = "ss1." } = {}) {
  const sender = await keyPair(fixture.senderPublicKey, fixture.senderPrivateKey);
  const owner = await crypto.subtle.importKey("raw", decode(fixture.accountPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: owner }, sender, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(context) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const nonce = decode(fixture.nonce);
  const aad = encoder.encode(JSON.stringify([context, fixture.sessionId, fixture.recipientUid, fixture.generation, fixture.summary.observedAt]).split(String.fromCharCode(0x2028)).join(String.fromCharCode(92) + "u2028"));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, encoder.encode(JSON.stringify(payload))));
  const envelope = new Uint8Array(nonce.length + ciphertext.length);
  envelope.set(nonce);
  envelope.set(ciphertext, nonce.length);
  return { senderPublicKey: fixture.senderPublicKey, sealed: prefix + encode(envelope) };
}

describe("owner session summaries", () => {
  it("opens the shared vector and reproduces it", async () => {
    expect(await open()).toEqual(fixture.summary);
    expect((await seal(fixture.summary)).sealed).toBe(fixture.sealed);
  });

  it("opens the vector sealed by the Go host (internal/summary)", async () => {
    const go = JSON.parse(goFixtureJSON);
    const key = await keyPair(go.recipientPublicKey, go.recipientPrivateKey);
    expect(await openSessionSummary(key, go.sessionId, go.recipientUid, go.generation, go.summary.observedAt, go)).toEqual(go.summary);
    expect(await openSessionSummary(key, go.sessionId.slice(0, -1), go.recipientUid, go.generation, go.summary.observedAt, go)).toBeNull();
  });

  it("is bound to the session, owner, generation and observation time", async () => {
    expect(await open(fixture, "different")).toBeNull();
    expect(await open(fixture, fixture.sessionId, "different")).toBeNull();
    expect(await open(fixture, fixture.sessionId, fixture.recipientUid, "different")).toBeNull();
    expect(await open(fixture, fixture.sessionId, fixture.recipientUid, fixture.generation, fixture.summary.observedAt + 1)).toBeNull();
  });

  it("never opens session content as a summary, or the wrong prefix", async () => {
    expect(await open(await seal(fixture.summary, { context: CONTENT }))).toBeNull();
    expect(await open(await seal(fixture.summary, { prefix: "sc1." }))).toBeNull();
    expect(await open({ ...fixture, sealed: fixture.sealed.slice(0, -2) + "AA" })).toBeNull();
  });

  it("requires exactly the protocol's keys, enums and bounds", async () => {
    const base = fixture.summary;
    const { source: _source, ...missing } = base;
    for (const payload of [
      { ...base, extra: true },
      missing,
      { ...base, version: 2 },
      { ...base, state: "done" },
      { ...base, source: "generic" },
      { ...base, title: "" },
      { ...base, title: "x".repeat(81) },
      { ...base, title: "two\nlines" },
      { ...base, summary: "y".repeat(481) },
      { ...base, summary: "bell\u0007" },
      { ...base, summary: "right-to-left ‮ override" },
      { ...base, summary: "zero​width" },
    ]) {
      expect(await open(await seal(payload)), JSON.stringify(payload)).toBeNull();
    }
    expect(await open(await seal({ ...base, title: "x".repeat(80), summary: "y".repeat(480) }))).not.toBeNull();
  });

  it("drops a decrypted summary that carries a link, address or markup", async () => {
    for (const summary of [
      "Visit https://evil.example/login to continue",
      "See www.evil-login.com for details",
      "Re-authenticate at evil-login.com now",
      "Mail admin@example.org",
      "Server is up on 10.0.0.12:8080",
      "Click [here](http://x)",
      "![img](x)",
      "<img src=x onerror=alert(1)>",
      "javascript:alert(1)",
      "&lt;script&gt;",
      "```sh\nrm -rf /\n```",
    ]) {
      expect(await open(await seal({ ...fixture.summary, summary })), summary).toBeNull();
    }
  });
});

describe("summary text guard", () => {
  it("keeps ordinary developer vocabulary", () => {
    for (const text of [
      "npm test failed in src/auth/login.test.ts (3 failures)",
      "Built package.json scripts; vite build finished in 4.2s",
      "Waiting for input: choose a migration to apply",
      "Docker compose up: api and db healthy",
    ]) expect(guardSummaryText(text, 480, true), text).toBe(true);
  });
});
