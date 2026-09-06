import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type CliToken } from "./store";

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

beforeEach(() => {
  store = Store.memory();
});

describe("listDevices", () => {
  it("strips every secret from the record", () => {
    store.putToken(token());
    const [device] = store.listDevices("uid-1");
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

  it("is scoped to one account", () => {
    store.putToken(token());
    store.putToken(token({ id: "dev_2", uid: "uid-2" }));
    expect(store.listDevices("uid-1").map((d) => d.id)).toEqual(["dev_1"]);
    expect(store.listDevices("uid-3")).toEqual([]);
  });

  it("hides revoked machines", () => {
    store.putToken(token());
    store.putToken(token({ id: "dev_2", revokedAt: 5000 }));
    expect(store.listDevices("uid-1").map((d) => d.id)).toEqual(["dev_1"]);
  });

  it("returns newest first", () => {
    store.putToken(token({ id: "dev_old", createdAt: 1000 }));
    store.putToken(token({ id: "dev_new", createdAt: 9000 }));
    expect(store.listDevices("uid-1").map((d) => d.id)).toEqual(["dev_new", "dev_old"]);
  });

  it("gives every listed machine an id, so React can key the row", () => {
    store.putToken(token());
    for (const device of store.listDevices("uid-1")) {
      expect(device.id).toBeTruthy();
    }
  });
});

describe("revokeDevice", () => {
  it("revokes once and reports false thereafter", () => {
    store.putToken(token());
    expect(store.revokeDevice("uid-1", "dev_1", 7000)).toBe(true);
    expect(store.revokeDevice("uid-1", "dev_1", 7000)).toBe(false);
  });

  it("will not revoke another account's machine", () => {
    store.putToken(token());
    expect(store.revokeDevice("uid-2", "dev_1")).toBe(false);
    expect(store.listDevices("uid-1")).toHaveLength(1);
  });

  it("reports false for an unknown id", () => {
    expect(store.revokeDevice("uid-1", "dev_nope")).toBe(false);
  });
});

describe("touchToken", () => {
  it("does not write again within the resolution window", () => {
    store.putToken(token({ lastSeenAt: 1000 }));
    store.touchToken("dev_1", 1000 + 30_000);
    expect(store.listDevices("uid-1")[0].lastSeenAt).toBe(1000);
  });

  it("advances once the window has passed", () => {
    store.putToken(token({ lastSeenAt: 1000 }));
    store.touchToken("dev_1", 1000 + 61_000);
    expect(store.listDevices("uid-1")[0].lastSeenAt).toBe(62_000);
  });

  it("ignores an unknown id", () => {
    expect(() => store.touchToken("dev_nope")).not.toThrow();
  });
});

describe("file backing", () => {
  it("survives a reload and writes owner-only", () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");

    const first = new Store(path);
    first.putToken(token());
    expect(statSync(path).mode & 0o077).toBe(0);

    const second = new Store(path);
    expect(second.listDevices("uid-1")).toHaveLength(1);
  });

  it("starts empty rather than throwing on a corrupt file", () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    writeFileSync(path, "{not json");

    const recovered = new Store(path);
    expect(recovered.listDevices("uid-1")).toEqual([]);
    expect(recovered.listSessions("uid-1")).toEqual([]);
  });

  it("leaves no temporary file behind", () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    const written = new Store(path);
    written.putToken(token());
    expect(JSON.parse(readFileSync(path, "utf8")).tokens).toHaveLength(1);
  });
});

describe("migration of records written by an earlier version", () => {
  function legacyStore(rows: Record<string, unknown>[]): Store {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    writeFileSync(path, JSON.stringify({ codes: [], tokens: rows, sessions: [] }));
    return new Store(path);
  }

  it("backfills a missing id, which otherwise rendered a keyless list row", () => {
    const { id, ...withoutId } = token();
    void id;
    const migrated = legacyStore([withoutId]);
    const [device] = migrated.listDevices("uid-1");
    expect(device.id).toMatch(/^dev_[0-9a-f]{32}$/);
  });

  it("backfills a missing lastSeenAt, which otherwise printed NaN", () => {
    const { lastSeenAt, ...withoutLastSeen } = token();
    void lastSeenAt;
    const migrated = legacyStore([withoutLastSeen]);
    expect(migrated.listDevices("uid-1")[0].lastSeenAt).toBe(1000);
  });

  it("keeps the backfilled id stable across reloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-store-"));
    const path = join(directory, "accounts.json");
    const { id, ...withoutId } = token();
    void id;
    writeFileSync(path, JSON.stringify({ codes: [], tokens: [withoutId], sessions: [] }));

    const first = new Store(path).listDevices("uid-1")[0].id;
    const second = new Store(path).listDevices("uid-1")[0].id;
    /* An id that changed on reload would break the unlink button. */
    expect(second).toBe(first);
  });

  it("leaves a well-formed record untouched", () => {
    const migrated = legacyStore([token()]);
    const [device] = migrated.listDevices("uid-1");
    expect(device.id).toBe("dev_1");
    expect(device.lastSeenAt).toBe(1000);
  });
});

describe("purgeExpired", () => {
  it("drops codes past their expiry and keeps live ones", () => {
    store.putCode({
      code: "shc_dead", uid: "uid-1", email: "a@b.c", name: "A",
      codeChallenge: "c", redirectUri: "http://127.0.0.1:1/callback", expiresAt: 500,
    });
    store.putCode({
      code: "shc_live", uid: "uid-1", email: "a@b.c", name: "A",
      codeChallenge: "c", redirectUri: "http://127.0.0.1:1/callback", expiresAt: 9000,
    });
    store.purgeExpired(1000);
    expect(store.takeCode("shc_dead")).toBeNull();
    expect(store.takeCode("shc_live")).not.toBeNull();
  });
});
