import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activity,
  applyFilters,
  byActor,
  isFiltered,
  sessionLabel,
  summarise,
  } from "./audit-view";
import type { AuditEvent, SessionRecord } from "./api";

const BASE = Date.UTC(2026, 8, 6, 12, 0, 0);

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `aud_${Math.random()}`,
    sessionId: "s1",
    at: BASE,
    actorUid: "u1",
    actorEmail: "ana@example.com",
    kind: "input",
    text: "npm test",
    ...overrides,
  };
}

describe("applyFilters", () => {
  const events = [
    event({ actorUid: "u1", sessionId: "s1", text: "git status" }),
    event({ actorUid: "u2", sessionId: "s2", text: "npm run build" }),
    event({ actorUid: "u1", sessionId: "s2", kind: "interrupt", text: "" }),
  ];

  it("returns everything when nothing is set", () => {
    expect(applyFilters(events, EMPTY_FILTERS)).toHaveLength(3);
  });

  it("narrows by person, session and kind", () => {
    expect(applyFilters(events, { ...EMPTY_FILTERS, actor: "u1" })).toHaveLength(2);
    expect(applyFilters(events, { ...EMPTY_FILTERS, session: "s2" })).toHaveLength(2);
    expect(applyFilters(events, { ...EMPTY_FILTERS, kind: "interrupt" })).toHaveLength(1);
  });

  it("combines filters rather than widening", () => {
    const found = applyFilters(events, { ...EMPTY_FILTERS, actor: "u1", session: "s2" });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("interrupt");
  });

  it("searches the text, ignoring case", () => {
    expect(applyFilters(events, { ...EMPTY_FILTERS, query: "GIT" })).toHaveLength(1);
    expect(applyFilters(events, { ...EMPTY_FILTERS, query: "npm" })).toHaveLength(1);
    expect(applyFilters(events, { ...EMPTY_FILTERS, query: "nothing here" })).toHaveLength(0);
  });

  it("ignores stray whitespace around a search, as from a paste", () => {
    expect(applyFilters(events, { ...EMPTY_FILTERS, query: "  npm  " })).toHaveLength(1);
  });

  it("narrows by age", () => {
    const recent = [event({ at: BASE }), event({ at: BASE - 60 * 60 * 1000 })];
    const found = applyFilters(recent, { ...EMPTY_FILTERS, since: 30 * 60 * 1000 }, BASE);
    expect(found).toHaveLength(1);
  });
});

describe("isFiltered", () => {
  it("knows when a view is narrowed", () => {
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, query: "  " })).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, query: "git" })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, since: 1000 })).toBe(true);
  });
});

describe("activity", () => {
  it("is empty for no events", () => {
    expect(activity([])).toEqual([]);
  });

  it("counts every event exactly once", () => {
    const events = Array.from({ length: 50 }, (_, i) => event({ at: BASE + i * 60_000 }));
    const buckets = activity(events, 10);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(50);
  });

  it("keeps a quiet stretch as an empty bucket rather than dropping it", () => {
    /* A gap that vanished would make the chart lie about the timeline. */
    const events = [event({ at: BASE }), event({ at: BASE + 10 * 60 * 60_000 })];
    const buckets = activity(events, 10);
    expect(buckets).toHaveLength(10);
    expect(buckets.some((bucket) => bucket.count === 0)).toBe(true);
  });

  it("survives every event sharing one instant", () => {
    const buckets = activity([event(), event(), event()], 8);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
  });
});

describe("tallies", () => {
  const events = [
    event({ actorUid: "u1", text: "git status" }),
    event({ actorUid: "u1", text: "git log" }),
    event({ actorUid: "u2", text: "npm test" }),
  ];

  it("ranks people by how much they did", () => {
    expect(byActor(events)).toEqual([
      { key: "u1", count: 2 },
      { key: "u2", count: 1 },
    ]);
  });


});

describe("summarise", () => {
  it("counts the things a reader asks first", () => {
    const summary = summarise([
      event({ actorUid: "u1", sessionId: "s1", at: BASE, kind: "opened" }),
      event({ actorUid: "u2", sessionId: "s2", at: BASE + 1000, kind: "handoff" }),
    ]);
    expect(summary).toMatchObject({
      total: 2, opened: 1, handoffs: 1, people: 2, sessions: 2,
      firstAt: BASE, lastAt: BASE + 1000,
    });
  });

  it("is all zeros for an empty log", () => {
    expect(summarise([])).toMatchObject({ total: 0, people: 0, sessions: 0 });
  });
});

describe("sessionLabel", () => {
  const sessions = [
    { id: "s1", name: "nightly build", command: "npm run build" } as SessionRecord,
    { id: "s2", command: "htop" } as SessionRecord,
  ];

  it("prefers the name, falls back to the command, never shows an id", () => {
    expect(sessionLabel(sessions, "s1")).toBe("nightly build");
    expect(sessionLabel(sessions, "s2")).toBe("htop");
    expect(sessionLabel(sessions, "gone")).toBe("a removed session");
  });
});
