import { describe, expect, it } from "vitest";
import { EMPTY, MAX_TABS, reduce, tabFor, type TabState } from "./tabs";
import type { SessionRecord } from "../lib/api";

function session(id: string, command = "top"): SessionRecord {
  return {
    id,
    shareUrl: `http://127.0.0.1:8788/s/${id}`,
    command,
    readOnly: false,
    encrypted: true,
    persistent: false,
    host: "ana-mbp",
    startedAt: 1,
  };
}

const open = (state: TabState, id: string) => reduce(state, { type: "open", session: session(id) });

describe("open", () => {
  it("adds a tab and makes it active", () => {
    const state = open(EMPTY, "a");
    expect(state.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(state.activeId).toBe("a");
  });

  it("selects an already-open session instead of duplicating it", () => {
    /* Two panes on one session would fight over the shared PTY size. */
    let state = open(open(EMPTY, "a"), "b");
    state = open(state, "a");
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.activeId).toBe("a");
  });

  it("carries the fields a pane needs", () => {
    const state = reduce(EMPTY, {
      type: "open",
      session: { ...session("a", "npm run dev"), readOnly: true },
    });
    expect(state.tabs[0]).toEqual({
      id: "a",
      label: "npm run dev",
      command: "npm run dev",
      shareUrl: "http://127.0.0.1:8788/s/a",
      readOnly: true,
      keyShare: undefined,
      canType: true,
    });
  });

  it("labels the tab with the operator's name when there is one", () => {
    const state = reduce(EMPTY, {
      type: "open",
      session: { ...session("a", "cat"), name: "scratch pad" },
    });
    expect(state.tabs[0].label).toBe("scratch pad");
    /* The command is still carried, since the row shows both. */
    expect(state.tabs[0].command).toBe("cat");
  });

  it("falls back to the command for a blank name", () => {
    const state = reduce(EMPTY, {
      type: "open",
      session: { ...session("a", "cat"), name: "   " },
    });
    expect(state.tabs[0].label).toBe("cat");
  });

  it("drops the oldest tab at the cap and keeps the new one active", () => {
    let state = EMPTY;
    for (let i = 0; i < MAX_TABS + 2; i += 1) state = open(state, `s${i}`);
    expect(state.tabs).toHaveLength(MAX_TABS);
    expect(state.tabs[0].id).toBe("s2");
    expect(state.activeId).toBe(`s${MAX_TABS + 1}`);
  });
});

describe("close", () => {
  it("removes the tab", () => {
    const state = reduce(open(open(EMPTY, "a"), "b"), { type: "close", id: "a" });
    expect(state.tabs.map((t) => t.id)).toEqual(["b"]);
  });

  it("lands on the next tab when the active one closes", () => {
    let state = open(open(open(EMPTY, "a"), "b"), "c");
    state = reduce(state, { type: "select", id: "b" });
    state = reduce(state, { type: "close", id: "b" });
    expect(state.activeId).toBe("c");
  });

  it("falls back to the previous tab when the last one closes", () => {
    let state = open(open(EMPTY, "a"), "b");
    state = reduce(state, { type: "close", id: "b" });
    expect(state.activeId).toBe("a");
  });

  it("returns to the list when the only tab closes", () => {
    const state = reduce(open(EMPTY, "a"), { type: "close", id: "a" });
    expect(state.tabs).toEqual([]);
    expect(state.activeId).toBeNull();
  });

  it("leaves the active tab alone when a different one closes", () => {
    let state = open(open(EMPTY, "a"), "b");
    state = reduce(state, { type: "close", id: "a" });
    expect(state.activeId).toBe("b");
  });

  it("ignores an unknown id", () => {
    const state = open(EMPTY, "a");
    expect(reduce(state, { type: "close", id: "nope" })).toBe(state);
  });
});

describe("who may type", () => {
  it("defaults to editable", () => {
    expect(open(EMPTY, "a").tabs[0].canType).toBe(true);
  });

  it("carries a watch-only tab, for a colleague who is neither owner nor assignee", () => {
    const state = reduce(EMPTY, { type: "open", session: session("a"), canType: false });
    expect(state.tabs[0].canType).toBe(false);
  });

  it("carries the key a colleague was given, so they can open it at all", () => {
    const state = reduce(EMPTY, {
      type: "open",
      session: { ...session("a"), keyShare: { senderPublicKey: "pk", sealed: "sealed" } },
    });
    expect(state.tabs[0].keyShare).toEqual({ senderPublicKey: "pk", sealed: "sealed" });
  });
});

describe("select", () => {
  it("switches tabs", () => {
    const state = reduce(open(open(EMPTY, "a"), "b"), { type: "select", id: "a" });
    expect(state.activeId).toBe("a");
  });

  it("goes back to the list with null", () => {
    const state = reduce(open(EMPTY, "a"), { type: "select", id: null });
    expect(state.activeId).toBeNull();
    /* The tab stays open, so its socket is not dropped. */
    expect(state.tabs).toHaveLength(1);
  });

  it("ignores a tab that is not open", () => {
    const state = open(EMPTY, "a");
    expect(reduce(state, { type: "select", id: "ghost" })).toBe(state);
  });
});

describe("reopening", () => {
/*
 * A session can be handed to someone who already has it open. The tab was a
 * snapshot taken when it was opened, so they stayed read-only until they
 * closed and reopened it, which nobody would think to do.
 */
it("takes the new answer on whether you may type when a session is reopened", () => {
  const record = session("s1");
  const watching = reduce(EMPTY, { type: "open", session: record, canType: false });
  expect(watching.tabs[0].canType).toBe(false);

  const assigned = reduce(watching, { type: "open", session: record, canType: true });
  expect(assigned.tabs).toHaveLength(1);
  expect(assigned.tabs[0].canType).toBe(true);
  expect(assigned.activeId).toBe("s1");
});

/* The password a colleague seals to you arrives after the tab is already open. */
it("picks up a key share that was not there when the tab was opened", () => {
  const before = reduce(EMPTY, { type: "open", session: session("s1") });
  expect(before.tabs[0].keyShare).toBeUndefined();

  const share = { senderPublicKey: "pk", sealed: "sealed" };
  const after = reduce(before, {
    type: "open",
    session: { ...session("s1"), keyShare: share },
  });
  expect(after.tabs[0].keyShare).toEqual(share);
});

/* Losing it would silently downgrade a tab that is working. */
it("keeps a key share when the refreshed session has none", () => {
  const share = { senderPublicKey: "pk", sealed: "sealed" };
  const open = reduce(EMPTY, { type: "open", session: { ...session("s1"), keyShare: share } });
  const again = reduce(open, { type: "open", session: session("s1") });
  expect(again.tabs[0].keyShare).toEqual(share);
});
});

describe("restore", () => {
  const restored = (state: TabState, ids: string[], activeId: string | null) =>
    reduce(state, {
      type: "restore",
      tabs: ids.map((id) => tabFor(session(id), true)),
      activeId,
    });

  it("puts back the tabs a reload found, on the one that was in front", () => {
    const state = restored(EMPTY, ["a", "b"], "b");
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.activeId).toBe("b");
  });

  /* The list arrives after the page, and a click in between is deliberate. */
  it("leaves a tab opened before the list arrived alone", () => {
    const opened = open(EMPTY, "live");
    expect(restored(opened, ["a", "b"], "b")).toBe(opened);
  });

  it("shows the list when the session that was in front has gone", () => {
    /* Its id is not among the tabs the list could rebuild. */
    const state = restored(EMPTY, ["a"], "b");
    expect(state.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(state.activeId).toBeNull();
  });

  it("keeps no more tabs than may be open at once", () => {
    const ids = Array.from({ length: MAX_TABS + 3 }, (_, index) => `s${index}`);
    const state = restored(EMPTY, ids, null);
    expect(state.tabs).toHaveLength(MAX_TABS);
    expect(state.tabs.map((t) => t.id)).toEqual(ids.slice(-MAX_TABS));
  });
});
