import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { MemoryStore } from "./store-memory";
import type { Store } from "./store";
import { exchangeCode, issueCode } from "./codes";
import { base64url, deriveChallenge } from "./pkce";
import { CODE_TTL_MS } from "./tokens";

const REDIRECT = "http://127.0.0.1:51234/callback";
let store: Store;
let verifier: string;

async function mint(now = Date.now()) {
  return await issueCode(
    store,
    {
      uid: "uid-1",
      email: "ana@example.com",
      name: "Ana",
      codeChallenge: deriveChallenge(verifier),
      redirectUri: REDIRECT,
    },
    now,
  );
}

beforeEach(async () => {
  store = MemoryStore.memory();
  verifier = base64url(randomBytes(48));
});

describe("exchangeCode", () => {
  it("returns the identity for a correct first exchange", async () => {
    const code = await mint();
    const result = await exchangeCode(store, { code, verifier, redirectUri: REDIRECT });
    expect(result).toEqual({ ok: true, uid: "uid-1", email: "ana@example.com", name: "Ana" });
  });

  it("rejects a replayed code", async () => {
    const code = await mint();
    expect((await exchangeCode(store, { code, verifier, redirectUri: REDIRECT })).ok).toBe(true);
    const replay = await exchangeCode(store, { code, verifier, redirectUri: REDIRECT });
    expect(replay).toEqual({ ok: false, reason: "replayed" });
  });

  it("detects a replay even when both exchanges share one millisecond", async () => {
    /* Replay detection must not depend on the clock advancing between calls. */
    const now = 1_000_000;
    const code = await mint(now);
    expect((await exchangeCode(store, { code, verifier, redirectUri: REDIRECT }, now)).ok).toBe(true);
    expect(await exchangeCode(store, { code, verifier, redirectUri: REDIRECT }, now)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("rejects an unknown code", async () => {
    expect(await exchangeCode(store, { code: "shc_nope", verifier, redirectUri: REDIRECT })).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("rejects a code past its ttl", async () => {
    const issuedAt = 1_000_000;
    const code = await mint(issuedAt);
    const result = await exchangeCode(
      store,
      { code, verifier, redirectUri: REDIRECT },
      issuedAt + CODE_TTL_MS + 1,
    );
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects the wrong verifier", async () => {
    const code = await mint();
    const wrong = base64url(randomBytes(48));
    expect(await exchangeCode(store, { code, verifier: wrong, redirectUri: REDIRECT })).toEqual({
      ok: false,
      reason: "challenge",
    });
  });

  it("rejects a redirect_uri that does not match the one bound to the code", async () => {
    const code = await mint();
    const result = await exchangeCode(store, {
      code,
      verifier,
      redirectUri: "http://127.0.0.1:9999/callback",
    });
    expect(result).toEqual({ ok: false, reason: "redirect" });
  });

  it("burns the code even when the verifier is wrong, so it cannot be retried", async () => {
    const code = await mint();
    const wrong = base64url(randomBytes(48));
    expect((await exchangeCode(store, { code, verifier: wrong, redirectUri: REDIRECT })).ok).toBe(false);
    expect(await exchangeCode(store, { code, verifier, redirectUri: REDIRECT })).toEqual({
      ok: false,
      reason: "replayed",
    });
  });
});
