import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store-memory";
import type { CliToken, Store } from "./store";

function token(overrides: Partial<CliToken> = {}): CliToken {
  return {
    id: "dev_1",
    accessHash: "ah1",
    refreshHash: "rh1",
    uid: "uid-1",
    email: "ana@example.com",
    name: "Ana",
    label: "ana-mbp",
    accessExpiresAt: 2000,
    createdAt: 1000,
    lastSeenAt: 1000,
    ...overrides,
  };
}

let store: Store;

beforeEach(async () => {
  store = MemoryStore.memory();
});

describe("listDevices", () => {
  it("strips every secret from the record", async () => {
    await store.putToken(token());
    const [device] = await store.listDevices("uid-1");
    expect(device).toEqual({
      id: "dev_1",
      label: "ana-mbp",
      createdAt: 1000,
      lastSeenAt: 1000,
      revokedAt: undefined,
    });
    expect(JSON.stringify(device)).not.toContain("ah1");
    expect(JSON.stringify(device)).not.toContain("rh1");
  });

  it("is scoped to one account", async () => {
    await store.putToken(token());
    await store.putToken(token({ id: "dev_2", uid: "uid-2" }));
    expect((await store.listDevices("uid-1")).map((d) => d.id)).toEqual(["dev_1"]);
    expect(await store.listDevices("uid-3")).toEqual([]);
  });

  it("hides revoked machines", async () => {
    await store.putToken(token());
    await store.putToken(token({ id: "dev_2", revokedAt: 5000 }));
    expect((await store.listDevices("uid-1")).map((d) => d.id)).toEqual(["dev_1"]);
  });

  it("returns newest first", async () => {
    await store.putToken(token({ id: "dev_old", createdAt: 1000 }));
    await store.putToken(token({ id: "dev_new", createdAt: 9000 }));
    expect((await store.listDevices("uid-1")).map((d) => d.id)).toEqual(["dev_new", "dev_old"]);
  });

  it("gives every listed machine an id, so React can key the row", async () => {
    await store.putToken(token());
    for (const device of await store.listDevices("uid-1")) {
      expect(device.id).toBeTruthy();
    }
  });
});

describe("revokeDevice", () => {
  it("revokes once and reports false thereafter", async () => {
    await store.putToken(token());
    expect(await store.revokeDevice("uid-1", "dev_1", 7000)).toBe(true);
    expect(await store.revokeDevice("uid-1", "dev_1", 7000)).toBe(false);
  });

  it("will not revoke another account's machine", async () => {
    await store.putToken(token());
    expect(await store.revokeDevice("uid-2", "dev_1")).toBe(false);
    expect(await store.listDevices("uid-1")).toHaveLength(1);
  });

  it("reports false for an unknown id", async () => {
    expect(await store.revokeDevice("uid-1", "dev_nope")).toBe(false);
  });
});

describe("touchToken", () => {
  it("does not write again within the resolution window", async () => {
    await store.putToken(token({ lastSeenAt: 1000 }));
    await store.touchToken("dev_1", 1000 + 30_000);
    expect((await store.listDevices("uid-1"))[0].lastSeenAt).toBe(1000);
  });

  it("advances once the window has passed", async () => {
    await store.putToken(token({ lastSeenAt: 1000 }));
    await store.touchToken("dev_1", 1000 + 61_000);
    expect((await store.listDevices("uid-1"))[0].lastSeenAt).toBe(62_000);
  });

  it("ignores an unknown id", async () => {
    await expect(store.touchToken("dev_nope")).resolves.toBeUndefined();
  });
});

describe("file backing", () => {
  it("survives a reload and writes owner-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");

    const first = new MemoryStore(path);
    first.putToken(token());
    expect(statSync(path).mode & 0o077).toBe(0);

    const second = new MemoryStore(path);
    expect(await second.listDevices("uid-1")).toHaveLength(1);
  });

  it("starts empty rather than throwing on a corrupt file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    writeFileSync(path, "{not json");

    const recovered = new MemoryStore(path);
    expect(await recovered.listDevices("uid-1")).toEqual([]);
    expect(await recovered.listSessions("uid-1")).toEqual([]);
  });

  it("leaves no temporary file behind", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    const written = new MemoryStore(path);
    written.putToken(token());
    expect(JSON.parse(readFileSync(path, "utf8")).tokens).toHaveLength(1);
  });
});

describe("migration of records written by an earlier version", () => {
  function legacyStore(rows: unknown[]): Store {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    writeFileSync(path, JSON.stringify({ codes: [], tokens: rows, sessions: [] }));
    return new MemoryStore(path);
  }

  it("backfills a missing id, which otherwise rendered a keyless list row", async () => {
    const { id, ...withoutId } = token();
    void id;
    const migrated = legacyStore([withoutId]);
    const [device] = await migrated.listDevices("uid-1");
    expect(device.id).toMatch(/^dev_[0-9a-f]{32}$/);
  });

  it("backfills a missing lastSeenAt, which otherwise printed NaN", async () => {
    const { lastSeenAt, ...withoutLastSeen } = token();
    void lastSeenAt;
    const migrated = legacyStore([withoutLastSeen]);
    expect((await migrated.listDevices("uid-1"))[0].lastSeenAt).toBe(1000);
  });

  it("keeps the backfilled id stable across reloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    const { id, ...withoutId } = token();
    void id;
    writeFileSync(path, JSON.stringify({ codes: [], tokens: [withoutId], sessions: [] }));

    const first = (await new MemoryStore(path).listDevices("uid-1"))[0].id;
    const second = (await new MemoryStore(path).listDevices("uid-1"))[0].id;
    /* An id that changed on reload would break the unlink button. */
    expect(second).toBe(first);
  });

  it("leaves a well-formed record untouched", async () => {
    const migrated = legacyStore([token()]);
    const [device] = await migrated.listDevices("uid-1");
    expect(device.id).toBe("dev_1");
    expect(device.lastSeenAt).toBe(1000);
  });
});

describe("purgeExpired", () => {
  it("drops codes past their expiry and keeps live ones", async () => {
    await store.putCode({
      code: "shc_dead", uid: "uid-1", email: "a@b.c", name: "A",
      codeChallenge: "c", redirectUri: "http://127.0.0.1:1/callback", expiresAt: 500,
    });
    await store.putCode({
      code: "shc_live", uid: "uid-1", email: "a@b.c", name: "A",
      codeChallenge: "c", redirectUri: "http://127.0.0.1:1/callback", expiresAt: 9000,
    });
    await store.purgeExpired(1000);
    expect(await store.takeCode("shc_dead")).toBeNull();
    expect(await store.takeCode("shc_live")).not.toBeNull();
  });
});
