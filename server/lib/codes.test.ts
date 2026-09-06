import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "./store";
import { exchangeCode, issueCode } from "./codes";
import { base64url, deriveChallenge } from "./pkce";
import { CODE_TTL_MS } from "./tokens";

const REDIRECT = "http://127.0.0.1:51234/callback";
let store: Store;
let verifier: string;

function mint(now = Date.now()) {
  return issueCode(
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

beforeEach(() => {
  store = Store.memory();
  verifier = base64url(randomBytes(48));
});

describe("exchangeCode", () => {
  it("returns the identity for a correct first exchange", () => {
    const code = mint();
    const result = exchangeCode(store, { code, verifier, redirectUri: REDIRECT });
    expect(result).toEqual({ ok: true, uid: "uid-1", email: "ana@example.com", name: "Ana" });
  });

  it("rejects a replayed code", () => {
    const code = mint();
    expect(exchangeCode(store, { code, verifier, redirectUri: REDIRECT }).ok).toBe(true);
    const replay = exchangeCode(store, { code, verifier, redirectUri: REDIRECT });
    expect(replay).toEqual({ ok: false, reason: "replayed" });
  });

  it("detects a replay even when both exchanges share one millisecond", () => {
    /* Replay detection must not depend on the clock advancing between calls. */
    const now = 1_000_000;
    const code = mint(now);
    expect(exchangeCode(store, { code, verifier, redirectUri: REDIRECT }, now).ok).toBe(true);
    expect(exchangeCode(store, { code, verifier, redirectUri: REDIRECT }, now)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("rejects an unknown code", () => {
    expect(exchangeCode(store, { code: "shc_nope", verifier, redirectUri: REDIRECT })).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("rejects a code past its ttl", () => {
    const issuedAt = 1_000_000;
    const code = mint(issuedAt);
    const result = exchangeCode(
      store,
      { code, verifier, redirectUri: REDIRECT },
      issuedAt + CODE_TTL_MS + 1,
    );
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects the wrong verifier", () => {
    const code = mint();
    const wrong = base64url(randomBytes(48));
    expect(exchangeCode(store, { code, verifier: wrong, redirectUri: REDIRECT })).toEqual({
      ok: false,
      reason: "challenge",
    });
  });

  it("rejects a redirect_uri that does not match the one bound to the code", () => {
    const code = mint();
    const result = exchangeCode(store, {
      code,
      verifier,
      redirectUri: "http://127.0.0.1:9999/callback",
    });
    expect(result).toEqual({ ok: false, reason: "redirect" });
  });

  it("burns the code even when the verifier is wrong, so it cannot be retried", () => {
    const code = mint();
    const wrong = base64url(randomBytes(48));
    expect(exchangeCode(store, { code, verifier: wrong, redirectUri: REDIRECT }).ok).toBe(false);
    expect(exchangeCode(store, { code, verifier, redirectUri: REDIRECT })).toEqual({
      ok: false,
      reason: "replayed",
    });
  });
});
