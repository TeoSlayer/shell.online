import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store-memory";
import type { Store } from "./store";
import { closeSession, listSessions, registerSession, sessionForApi, sessionSource } from "./sessions";

const valid = {
  id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
  shareUrl: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
  command: "claude",
  deviceId: "dev_1",
};

let store: Store;

beforeEach(async () => {
  store = MemoryStore.memory();
});

describe("registerSession", () => {
  it("stores a session against the calling uid", async () => {
    const result = await registerSession(store, "uid-1", valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.uid).toBe("uid-1");
      expect(result.session.id).toBe(valid.id);
      expect(sessionSource(result.session).deviceId).toBe("dev_1");
    }
  });

  it("retains the owning device without exposing its storage envelope", async () => {
    const result = await registerSession(store, "uid-1", { ...valid, origin: "cmd_1" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.session.origin).toContain("shell-online-source:");
    expect(sessionForApi(result.session)).toMatchObject({ origin: "cmd_1", deviceId: "dev_1" });
  });

  it("is idempotent, so a re-register updates rather than duplicates", async () => {
    await registerSession(store, "uid-1", valid);
    await registerSession(store, "uid-1", { ...valid, command: "codex" });
    const sessions = await listSessions(store, "uid-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].command).toBe("codex");
  });

  it("rejects an id that is not the relay's format", async () => {
    expect((await registerSession(store, "uid-1", { ...valid, id: "" })).ok).toBe(false);
    expect((await registerSession(store, "uid-1", { ...valid, id: "short" })).ok).toBe(false);
    expect((await registerSession(store, "uid-1", { ...valid, id: "has spaces!" })).ok).toBe(false);
    expect((await registerSession(store, "uid-1", { ...valid, id: "a".repeat(65) })).ok).toBe(false);
  });

  it("rejects a share url that is not http", async () => {
    expect((await registerSession(store, "uid-1", { ...valid, shareUrl: "" })).ok).toBe(false);
    expect(
      (await registerSession(store, "uid-1", { ...valid, shareUrl: "javascript:alert(1)" })).ok,
    ).toBe(false);
  });

  it("rejects an empty command", async () => {
    expect((await registerSession(store, "uid-1", { ...valid, command: "" })).ok).toBe(false);
  });

  it("truncates an over-long command rather than rejecting it", async () => {
    const result = await registerSession(store, "uid-1", { ...valid, command: "x".repeat(1000) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.command).toHaveLength(300);
  });

  it("defaults the optional flags to false", async () => {
    const result = await registerSession(store, "uid-1", valid);
    if (!result.ok) throw new Error("expected ok");
    expect(result.session.readOnly).toBe(false);
    expect(result.session.encrypted).toBe(false);
    expect(result.session.persistent).toBe(false);
  });
});

describe("listSessions", () => {
  it("never returns another account's sessions", async () => {
    await registerSession(store, "uid-1", valid);
    await registerSession(store, "uid-2", { ...valid, id: "OTHERdeadbeefOTHERdeadbeef000000" });
    expect(await listSessions(store, "uid-1")).toHaveLength(1);
    expect((await listSessions(store, "uid-1"))[0].uid).toBe("uid-1");
    expect(await listSessions(store, "uid-3")).toEqual([]);
  });

  it("returns newest first", async () => {
    await registerSession(store, "uid-1", { ...valid, id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, 1000);
    await registerSession(store, "uid-1", { ...valid, id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }, 3000);
    await registerSession(store, "uid-1", { ...valid, id: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }, 2000);
    expect((await listSessions(store, "uid-1")).map((s) => s.id[0])).toEqual(["B", "C", "A"]);
  });
});

describe("closeSession", () => {
  it("stamps closedAt and the exit code", async () => {
    await registerSession(store, "uid-1", valid);
    const closed = await closeSession(store, "uid-1", valid.id, 0, 5000);
    expect(closed?.closedAt).toBe(5000);
    expect(closed?.exitCode).toBe(0);
  });

  it("will not close another account's session", async () => {
    await registerSession(store, "uid-1", valid);
    expect(await closeSession(store, "uid-2", valid.id, 0)).toBeNull();
    expect((await listSessions(store, "uid-1"))[0].closedAt).toBeUndefined();
  });

  it("returns null for an unknown session", async () => {
    expect(await closeSession(store, "uid-1", "NOPEnopeNOPEnopeNOPEnopeNOPEnope", 0)).toBeNull();
  });
});
