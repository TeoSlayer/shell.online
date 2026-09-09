import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOpenTabs, writeOpenTabs } from "./tab-store";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: fakeStorage() });
});

describe("the tabs a reload finds", () => {
  it("returns what was open, and which one was in front", () => {
    writeOpenTabs("uid-1", { ids: ["a", "b"], activeId: "b" });
    expect(readOpenTabs("uid-1")).toEqual({ ids: ["a", "b"], activeId: "b" });
  });

  it("hands nothing to another account on the same computer", () => {
    writeOpenTabs("uid-1", { ids: ["a"], activeId: "a" });
    expect(readOpenTabs("uid-2")).toEqual({ ids: [], activeId: null });
  });

  it("drops an active id that is not among the tabs", () => {
    writeOpenTabs("uid-1", { ids: ["a"], activeId: "gone" });
    expect(readOpenTabs("uid-1").activeId).toBeNull();
  });

  it("reads nothing rather than throwing on damaged storage", () => {
    window.localStorage.setItem("shell.online:sessions:tabs:v1", "{not json");
    expect(readOpenTabs("uid-1")).toEqual({ ids: [], activeId: null });
  });

  it("survives storage being unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => writeOpenTabs("uid-1", { ids: ["a"], activeId: "a" })).not.toThrow();
    expect(readOpenTabs("uid-1")).toEqual({ ids: [], activeId: null });
  });
});
