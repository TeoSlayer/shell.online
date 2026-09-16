import { describe, expect, it } from "vitest";
import { difference, garrisonFrom, isOnTheField, workFor } from "./sessions";
import type { SessionRecord } from "../../lib/api";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    uid: "u1",
    command: "claude",
    shareUrl: "https://shell.online/s/s1",
    readOnly: false,
    encrypted: true,
    persistent: false,
    host: "laptop",
    startedAt: 1000,
    ...overrides,
  } as SessionRecord;
}

describe("reading what a session is doing", () => {
  it("knows mending from the words people already use", () => {
    expect(workFor("fix: audit seal")).toBe("bug");
    expect(workFor("hotfix the relay")).toBe("bug");
    expect(workFor("debug the importer")).toBe("bug");
  });

  it("knows making", () => {
    expect(workFor("feat: session board")).toBe("feature");
    expect(workFor("add a roster panel")).toBe("feature");
    expect(workFor("refactor the store")).toBe("feature");
  });

  it("reads a fix to a new thing as a fix", () => {
    /*
     * "fix the new importer" contains both. Calling it a feature because of
     * "new" would be exactly backwards: the fix is the more specific claim.
     */
    expect(workFor("fix the new importer")).toBe("bug");
    expect(workFor("add a fix for the importer")).toBe("bug");
  });

  it("says nothing rather than guessing", () => {
    /* Pretending to know is worse than showing that you do not. */
    expect(workFor("npm run dev")).toBe("idle");
    expect(workFor("")).toBe("idle");
    expect(workFor("htop")).toBe("idle");
  });

  it("is not fooled by a word inside another word", () => {
    expect(workFor("prefixes")).toBe("idle");
    expect(workFor("addendum")).toBe("idle");
  });
});

describe("who is on the field", () => {
  it("leaves out sessions that have finished", () => {
    expect(isOnTheField(session())).toBe(true);
    expect(isOnTheField(session({ closedAt: 2000 }))).toBe(false);
  });

  it("gives each wright the class of its harness", () => {
    const garrison = garrisonFrom([
      session({ id: "a", command: "claude --resume x" }),
      session({ id: "b", command: "codex resume last" }),
      session({ id: "c", command: "npm run dev" }),
    ]);
    expect(garrison.map((entry) => entry.kind)).toEqual(["claude-code", "codex", "terminal"]);
  });

  it("sees through the shell a browser-started session arrives in", () => {
    /* The same unwrapping the session list does; see lib/session-kinds.ts. */
    const [wright] = garrisonFrom([session({ command: `sh -c "claude --model opus"` })]);
    expect(wright.kind).toBe("claude-code");
  });

  it("prefers the operator's name over the command", () => {
    const [wright] = garrisonFrom([session({ name: "fix: audit seal", command: "claude" })]);
    expect(wright.name).toBe("fix: audit seal");
    expect(wright.work).toBe("bug");
  });

  it("falls back to the command when there is no name", () => {
    const [wright] = garrisonFrom([session({ command: "htop" })]);
    expect(wright.name).toBe("htop");
  });

  it("keeps a stable order, so the field does not reshuffle on every poll", () => {
    const first = garrisonFrom([
      session({ id: "b", startedAt: 20 }),
      session({ id: "a", startedAt: 10 }),
    ]);
    const second = garrisonFrom([
      session({ id: "a", startedAt: 10 }),
      session({ id: "b", startedAt: 20 }),
    ]);
    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id));
  });
});

/** A roster entry, with the session facts the panel needs. */
const muster = (id: string) => ({
  id,
  name: id,
  kind: "terminal",
  work: "idle" as const,
  session: { id, startedAt: 0, host: "laptop", command: "htop" },
});

describe("keeping the field in step with the list", () => {
  it("brings in the new and sends home the finished", () => {
    const present = [{ id: "a" }, { id: "b" }];
    const wanted = [muster("b"), muster("c")];
    const { arrived, left } = difference(present, wanted);
    expect(arrived.map((entry) => entry.id)).toEqual(["c"]);
    expect(left).toEqual(["a"]);
  });

  it("leaves everybody alone when nothing has changed", () => {
    /*
     * The point of the whole function: the list is polled every few seconds,
     * and rebuilding the field each time would teleport the garrison back to
     * the gate at exactly that interval.
     */
    const present = [{ id: "a" }, { id: "b" }];
    const wanted = [muster("a"), muster("b")];
    const { arrived, left } = difference(present, wanted);
    expect(arrived).toHaveLength(0);
    expect(left).toHaveLength(0);
  });
});
