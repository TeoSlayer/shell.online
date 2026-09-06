import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store";
import {
  ACCESS_TTL_MS,
  checkAccessToken,
  constantTimeEqual,
  hashSecret,
  issueTokens,
  mintSecret,
  refreshAccessToken,
  revokeByRefreshToken,
} from "./tokens";

const identity = { uid: "uid-1", email: "ana@example.com", name: "Ana", label: "laptop" };
let store: Store;

beforeEach(() => {
  store = Store.memory();
});

describe("mintSecret", () => {
  it("prefixes and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const secret = mintSecret("sha");
      expect(secret.startsWith("sha_")).toBe(true);
      expect(seen.has(secret)).toBe(false);
      seen.add(secret);
    }
  });
});

describe("issueTokens", () => {
  it("stores only hashes, never the secrets", () => {
    const tokens = issueTokens(store, identity);
    const serialised = JSON.stringify(store);
    expect(serialised).not.toContain(tokens.accessToken);
    expect(serialised).not.toContain(tokens.refreshToken);
    expect(store.findByAccessHash(hashSecret(tokens.accessToken))).not.toBeNull();
  });

  it("issues distinct access and refresh secrets", () => {
    const tokens = issueTokens(store, identity);
    expect(tokens.accessToken).not.toBe(tokens.refreshToken);
  });
});

describe("checkAccessToken", () => {
  it("accepts a fresh token and returns the bound identity", () => {
    const tokens = issueTokens(store, identity);
    const result = checkAccessToken(store, tokens.accessToken);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.uid).toBe("uid-1");
  });

  it("rejects an unknown token", () => {
    expect(checkAccessToken(store, "sha_nope")).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a token past its ttl", () => {
    const issuedAt = 1_000_000;
    const tokens = issueTokens(store, identity, issuedAt);
    expect(checkAccessToken(store, tokens.accessToken, issuedAt + ACCESS_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a revoked token", () => {
    const tokens = issueTokens(store, identity);
    revokeByRefreshToken(store, tokens.refreshToken);
    expect(checkAccessToken(store, tokens.accessToken)).toEqual({ ok: false, reason: "revoked" });
  });

  it("does not accept the refresh token as an access token", () => {
    const tokens = issueTokens(store, identity);
    expect(checkAccessToken(store, tokens.refreshToken).ok).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  it("issues a new access token and retires the old one", () => {
    const tokens = issueTokens(store, identity);
    const refreshed = refreshAccessToken(store, tokens.refreshToken);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    expect(checkAccessToken(store, refreshed.accessToken).ok).toBe(true);
    expect(checkAccessToken(store, tokens.accessToken).ok).toBe(false);
  });

  it("rejects an unknown refresh token", () => {
    expect(refreshAccessToken(store, "shr_nope")).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a revoked refresh token", () => {
    const tokens = issueTokens(store, identity);
    revokeByRefreshToken(store, tokens.refreshToken);
    expect(refreshAccessToken(store, tokens.refreshToken)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });
});

describe("revokeByRefreshToken", () => {
  it("reports true once and false thereafter", () => {
    const tokens = issueTokens(store, identity);
    expect(revokeByRefreshToken(store, tokens.refreshToken)).toBe(true);
    expect(revokeByRefreshToken(store, tokens.refreshToken)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("compares equal and unequal values without throwing on length mismatch", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
