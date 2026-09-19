import { describe, expect, it } from "vitest";
import { deriveStats, NO_STATS } from "./game-stats";
import type { SessionRecord } from "./types";

/**
 * The counted work.
 *
 * Every assertion here is really the same one: the game's ladder is a read-out
 * of sessions that happened, and nothing else can move it. That is the claim
 * `state/progress.ts` makes at the top of the file, and it was untrue for a
 * while -- the experience bar was fed the simulation's tally, so a tab left
 * open overnight levelled you up.
 */

const DAY = 24 * 60 * 60 * 1000;
const MONDAY = Date.parse("2026-09-14T09:00:00Z");

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    uid: "u1",
    shareUrl: "https://example.invalid/s",
    command: "npm run dev",
    readOnly: false,
    encrypted: true,
    persistent: false,
    host: "laptop",
    startedAt: MONDAY,
    closedAt: MONDAY + 60_000,
    exitCode: 0,
    ...over,
  };
}

describe("counting nothing", () => {
  it("counts nothing for an account with no sessions", () => {
    expect(deriveStats([])).toEqual(NO_STATS);
  });
});

describe("what counts as finished", () => {
  it("counts a session that closed cleanly", () => {
    expect(deriveStats([session()]).sessions).toBe(1);
  });

  it("does not count one that is still running", () => {
    /* An open session is the open loop the field is drawing, not an earning. */
    const running = session({ closedAt: undefined, exitCode: undefined });
    expect(deriveStats([running]).sessions).toBe(0);
    expect(deriveStats([running]).started).toBe(1);
  });

  it("does not count one that ended badly", () => {
    expect(deriveStats([session({ exitCode: 1 })]).sessions).toBe(0);
  });

  it("counts an older record that closed without saying how", () => {
    /*
     * Records from before exit codes were stored have no code at all. Refusing
     * to count them would quietly rewrite somebody's history, and the service
     * has nothing better to go on than the fact that the session ended.
     */
    expect(deriveStats([session({ exitCode: undefined })]).sessions).toBe(1);
  });
});

describe("days", () => {
  it("counts a day once however many sessions ran on it", () => {
    const stats = deriveStats([session(), session(), session()]);
    expect(stats.days).toBe(1);
    expect(stats.sessions).toBe(3);
  });

  it("counts separate days separately", () => {
    const stats = deriveStats([
      session({ startedAt: MONDAY }),
      session({ startedAt: MONDAY + DAY }),
      session({ startedAt: MONDAY + 2 * DAY }),
    ]);
    expect(stats.days).toBe(3);
  });

  it("counts the day a session started even when it never finished", () => {
    /* Turning up is turning up, whatever became of the session. */
    const stats = deriveStats([session({ closedAt: undefined, exitCode: undefined })]);
    expect(stats.days).toBe(1);
    expect(stats.sessions).toBe(0);
  });
});

describe("machines", () => {
  it("counts each machine once", () => {
    const stats = deriveStats([
      session({ host: "laptop" }),
      session({ host: "laptop" }),
      session({ host: "workshop" }),
    ]);
    expect(stats.machines).toBe(2);
  });
});

describe("what the session was", () => {
  it("reads fixing and making from the name", () => {
    const stats = deriveStats([
      session({ name: "fix: audit seal" }),
      session({ name: "feat: session board" }),
      session({ name: "npm run dev" }),
    ]);
    expect(stats.mended).toBe(1);
    expect(stats.made).toBe(1);
    expect(stats.sessions).toBe(3);
  });

  it("falls back to the command when there is no name", () => {
    /* The same rule the session list uses to decide what to print. */
    const stats = deriveStats([session({ name: undefined, command: "git commit -m fix" })]);
    expect(stats.mended).toBe(1);
  });

  it("prefers the name over the command, as the list does", () => {
    const stats = deriveStats([session({ name: "feat: the board", command: "fix things" })]);
    expect(stats.made).toBe(1);
    expect(stats.mended).toBe(0);
  });

  it("does not classify a session that did not finish", () => {
    const stats = deriveStats([
      session({ name: "fix: audit seal", closedAt: undefined, exitCode: undefined }),
    ]);
    expect(stats.mended).toBe(0);
  });

  it("puts a session in at most one column", () => {
    const stats = deriveStats([session({ name: "fix the new importer" })]);
    expect(stats.mended + stats.made).toBe(1);
  });
});

describe("what it does not do", () => {
  it("never looks inside a session", () => {
    /*
     * Sessions are end-to-end encrypted and the service could not read one if
     * it wanted to. What is counted here is rows and the names people gave
     * their own sessions, which is the whole of tier one. The guard is that
     * `SessionRecord` carries no output at all -- if that ever changes, this
     * test is where somebody should have to think about it.
     */
    const record = session();
    expect(Object.keys(record)).not.toContain("output");
    expect(Object.keys(record)).not.toContain("text");
  });

  it("survives a record with a broken timestamp", () => {
    const stats = deriveStats([session({ startedAt: Number.NaN })]);
    expect(stats.days).toBe(0);
    expect(stats.started).toBe(1);
  });
});
