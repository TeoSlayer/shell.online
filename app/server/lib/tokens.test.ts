import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store-memory";
import { deferred } from "./store-deferred";
import type { Store } from "./store";
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

beforeEach(async () => {
  store = MemoryStore.memory();
});

describe("mintSecret", () => {
  it("prefixes and never repeats", async () => {
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
  it("stores only hashes, never the secrets", async () => {
    const tokens = await issueTokens(store, identity);
    const serialised = JSON.stringify(store);
    expect(serialised).not.toContain(tokens.accessToken);
    expect(serialised).not.toContain(tokens.refreshToken);
    expect(await store.findByAccessHash(hashSecret(tokens.accessToken))).not.toBeNull();
  });

  it("issues distinct access and refresh secrets", async () => {
    const tokens = await issueTokens(store, identity);
    expect(tokens.accessToken).not.toBe(tokens.refreshToken);
  });

  it("reuses the device a machine already has, keeping its id and age", async () => {
    const first = await issueTokens(store, { ...identity, machineId: "machine-a" }, 1000);
    const second = await issueTokens(
      store,
      { ...identity, machineId: "machine-a", label: "renamed" },
      9000,
    );
    expect(second.deviceId).toBe(first.deviceId);

    const devices = await store.listDevices("uid-1");
    expect(devices).toHaveLength(1);
    expect(devices[0].createdAt).toBe(1000);
    expect(devices[0].label).toBe("renamed");
  });

  it("retires the credentials the previous login on that machine was given", async () => {
    const first = await issueTokens(store, { ...identity, machineId: "machine-a" });
    const second = await issueTokens(store, { ...identity, machineId: "machine-a" });
    expect((await checkAccessToken(store, second.accessToken)).ok).toBe(true);
    expect((await checkAccessToken(store, first.accessToken)).ok).toBe(false);
    expect(await refreshAccessToken(store, first.refreshToken)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("records a device per login when no machine is named", async () => {
    await issueTokens(store, identity);
    await issueTokens(store, identity);
    expect(await store.listDevices("uid-1")).toHaveLength(2);
  });

  it("keeps one account's machine id away from another account's device", async () => {
    const mine = await issueTokens(store, { ...identity, machineId: "machine-a" });
    const theirs = await issueTokens(store, {
      uid: "uid-2",
      email: "bruno@example.com",
      name: "Bruno",
      label: "laptop",
      machineId: "machine-a",
    });
    expect(theirs.deviceId).not.toBe(mine.deviceId);
    expect((await checkAccessToken(store, mine.accessToken)).ok).toBe(true);
  });
});

describe("checkAccessToken", () => {
  it("accepts a fresh token and returns the bound identity", async () => {
    const tokens = await issueTokens(store, identity);
    const result = await checkAccessToken(store, tokens.accessToken);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.uid).toBe("uid-1");
  });

  it("rejects an unknown token", async () => {
    expect(await checkAccessToken(store, "sha_nope")).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a token past its ttl", async () => {
    const issuedAt = 1_000_000;
    const tokens = await issueTokens(store, identity, issuedAt);
    expect(await checkAccessToken(store, tokens.accessToken, issuedAt + ACCESS_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a revoked token", async () => {
    const tokens = await issueTokens(store, identity);
    await revokeByRefreshToken(store, tokens.refreshToken);
    expect(await checkAccessToken(store, tokens.accessToken)).toEqual({ ok: false, reason: "revoked" });
  });

  it("does not accept the refresh token as an access token", async () => {
    const tokens = await issueTokens(store, identity);
    expect((await checkAccessToken(store, tokens.refreshToken)).ok).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  it("issues a new access token and retires the old one", async () => {
    const tokens = await issueTokens(store, identity);
    const refreshed = await refreshAccessToken(store, tokens.refreshToken);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    expect((await checkAccessToken(store, refreshed.accessToken)).ok).toBe(true);
    expect((await checkAccessToken(store, tokens.accessToken)).ok).toBe(false);
  });

  it("rejects an unknown refresh token", async () => {
    expect(await refreshAccessToken(store, "shr_nope")).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a revoked refresh token", async () => {
    const tokens = await issueTokens(store, identity);
    await revokeByRefreshToken(store, tokens.refreshToken);
    expect(await refreshAccessToken(store, tokens.refreshToken)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });
});

describe("revokeByRefreshToken", () => {
  it("reports true once and false thereafter", async () => {
    const tokens = await issueTokens(store, identity);
    expect(await revokeByRefreshToken(store, tokens.refreshToken)).toBe(true);
    expect(await revokeByRefreshToken(store, tokens.refreshToken)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("compares equal and unequal values without throwing on length mismatch", async () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("issuing against a store that does not write synchronously", () => {
  /*
   * A database write completes on a later turn of the event loop. Returning
   * credentials before the device row exists would hand a machine a token
   * that authenticates nothing, and would turn a failed insert into an
   * unhandled rejection rather than an error the caller sees.
   */
  it("does not return credentials before the device row exists", async () => {
    const slow = deferred(MemoryStore.memory());
    const tokens = await issueTokens(slow, {
      uid: "uid-1",
      email: "ana@example.com",
      name: "Ana Ruiz",
      label: "laptop",
    });
    expect(await slow.findByAccessHash(hashSecret(tokens.accessToken))).not.toBeNull();
  });
});
