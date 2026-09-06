import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store";
import { closeSession, listSessions, registerSession } from "./sessions";

const valid = {
  id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
  shareUrl: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
  command: "claude",
};

let store: Store;

beforeEach(() => {
  store = Store.memory();
});

describe("registerSession", () => {
  it("stores a session against the calling uid", () => {
    const result = registerSession(store, "uid-1", valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.uid).toBe("uid-1");
      expect(result.session.id).toBe(valid.id);
    }
  });

  it("is idempotent, so a re-register updates rather than duplicates", () => {
    registerSession(store, "uid-1", valid);
    registerSession(store, "uid-1", { ...valid, command: "codex" });
    const sessions = listSessions(store, "uid-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].command).toBe("codex");
  });

  it("rejects an id that is not the relay's format", () => {
    expect(registerSession(store, "uid-1", { ...valid, id: "" }).ok).toBe(false);
    expect(registerSession(store, "uid-1", { ...valid, id: "short" }).ok).toBe(false);
    expect(registerSession(store, "uid-1", { ...valid, id: "has spaces!" }).ok).toBe(false);
    expect(registerSession(store, "uid-1", { ...valid, id: "a".repeat(65) }).ok).toBe(false);
  });

  it("rejects a share url that is not http", () => {
    expect(registerSession(store, "uid-1", { ...valid, shareUrl: "" }).ok).toBe(false);
    expect(
      registerSession(store, "uid-1", { ...valid, shareUrl: "javascript:alert(1)" }).ok,
    ).toBe(false);
  });

  it("rejects an empty command", () => {
    expect(registerSession(store, "uid-1", { ...valid, command: "" }).ok).toBe(false);
  });

  it("truncates an over-long command rather than rejecting it", () => {
    const result = registerSession(store, "uid-1", { ...valid, command: "x".repeat(1000) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.command).toHaveLength(300);
  });

  it("defaults the optional flags to false", () => {
    const result = registerSession(store, "uid-1", valid);
    if (!result.ok) throw new Error("expected ok");
    expect(result.session.readOnly).toBe(false);
    expect(result.session.encrypted).toBe(false);
    expect(result.session.persistent).toBe(false);
  });
});

describe("listSessions", () => {
  it("never returns another account's sessions", () => {
    registerSession(store, "uid-1", valid);
    registerSession(store, "uid-2", { ...valid, id: "OTHERdeadbeefOTHERdeadbeef000000" });
    expect(listSessions(store, "uid-1")).toHaveLength(1);
    expect(listSessions(store, "uid-1")[0].uid).toBe("uid-1");
    expect(listSessions(store, "uid-3")).toEqual([]);
  });

  it("returns newest first", () => {
    registerSession(store, "uid-1", { ...valid, id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, 1000);
    registerSession(store, "uid-1", { ...valid, id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }, 3000);
    registerSession(store, "uid-1", { ...valid, id: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }, 2000);
    expect(listSessions(store, "uid-1").map((s) => s.id[0])).toEqual(["B", "C", "A"]);
  });
});

describe("closeSession", () => {
  it("stamps closedAt and the exit code", () => {
    registerSession(store, "uid-1", valid);
    const closed = closeSession(store, "uid-1", valid.id, 0, 5000);
    expect(closed?.closedAt).toBe(5000);
    expect(closed?.exitCode).toBe(0);
  });

  it("will not close another account's session", () => {
    registerSession(store, "uid-1", valid);
    expect(closeSession(store, "uid-2", valid.id, 0)).toBeNull();
    expect(listSessions(store, "uid-1")[0].closedAt).toBeUndefined();
  });

  it("returns null for an unknown session", () => {
    expect(closeSession(store, "uid-1", "NOPEnopeNOPEnopeNOPEnopeNOPEnope", 0)).toBeNull();
  });
});
