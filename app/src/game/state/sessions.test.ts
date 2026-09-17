import { describe, expect, it } from "vitest";
import { classFor, nameOf, ownerOf, rosterFrom, workFor } from "./sessions";
import type { Member, SessionRecord } from "../../lib/api";

/**
 * Turning a team and its sessions into a field.
 *
 * The join everything else rests on: a soldier belongs to the hero who owns its
 * session. Ten Claude Code sessions and three OpenClaw ones owned by one person
 * are thirteen soldiers of two classes, all of them hers -- which is the
 * worked example in the specification and the first test below.
 */

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: `s-${Math.random().toString(36).slice(2)}`,
  shareUrl: "https://example.invalid/s",
  command: "npm run dev",
  readOnly: false,
  encrypted: true,
  persistent: false,
  host: "laptop",
  startedAt: 1000,
  ...over,
});

const member = (uid: string, over: Partial<Member> = {}): Member => ({
  orgId: "org-1",
  uid,
  email: `${uid}@example.invalid`,
  name: "",
  role: "member",
  joinedAt: 1000,
  ...over,
});

describe("reading the work", () => {
  it("reads mending first", () => {
    /*
     * "fix the new importer" is a fix. Reading it as a feature because it
     * contains "new" would be exactly backwards, and fixes are the more
     * specific claim.
     */
    expect(workFor("fix: audit seal")).toBe("bug");
    expect(workFor("fix the new importer")).toBe("bug");
    expect(workFor("feat: session board")).toBe("feature");
    expect(workFor("npm run dev")).toBe("idle");
  });
});

describe("whose session it is", () => {
  it("takes the owner when there is one", () => {
    expect(ownerOf(session({ ownerUid: "ada" }), "viewer")).toBe("ada");
  });

  it("falls back to whoever it was handed to", () => {
    expect(ownerOf(session({ assigneeUids: ["grace"] }), "viewer")).toBe("grace");
    expect(ownerOf(session({ assigneeUid: "alan" }), "viewer")).toBe("alan");
  });

  it("falls back to the viewer for a row too old to say", () => {
    /*
     * A soldier with no hero is a figure standing in open country with nobody
     * to follow. Rows from before sessions recorded an owner have none, and the
     * person looking can only be seeing it because it is theirs or their team's
     * -- of which the first is much the likelier for a row that old.
     */
    expect(ownerOf(session(), "viewer")).toBe("viewer");
  });
});

describe("what to call somebody", () => {
  it("uses their name", () => {
    expect(nameOf(member("ada", { name: "Ada Lovelace" }))).toBe("Ada Lovelace");
  });

  it("falls back to the part of the address before the at sign", () => {
    expect(nameOf(member("ada"))).toBe("ada");
  });

  it("falls back to a short id when there is neither", () => {
    expect(nameOf({ uid: "0123456789abcdef" })).toBe("01234567");
  });
});

describe("which class a hero is drawn as", () => {
  it("is the harness they run most", () => {
    /*
     * Their own chosen class lives in their own saved game, which this account
     * cannot read for anybody else. What everybody can see is what a colleague
     * is running, so that is what decides how they are drawn -- and it has the
     * advantage of being true.
     */
    expect(
      classFor([
        session({ command: "claude" }),
        session({ command: "claude --resume abc" }),
        session({ command: "codex" }),
      ]),
    ).toBe("claude-code");
  });

  it("is a footman when they are running nothing", () => {
    expect(classFor([])).toBe("terminal");
  });

  it("does not depend on the order sessions came back in", () => {
    const one = session({ command: "codex" });
    const two = session({ command: "claude" });
    expect(classFor([one, two])).toBe(classFor([two, one]));
  });
});

describe("the roster", () => {
  it("gives one person thirteen soldiers of two classes", () => {
    const sessions = [
      ...Array.from({ length: 10 }, () => session({ command: "claude", ownerUid: "ada" })),
      ...Array.from({ length: 3 }, () => session({ command: "openclaw", ownerUid: "ada" })),
    ];
    const roster = rosterFrom(sessions, [member("ada")], { uid: "ada" });

    expect(roster.soldiers).toHaveLength(13);
    expect(roster.soldiers.every((soldier) => soldier.heroUid === "ada")).toBe(true);
    expect(new Set(roster.soldiers.map((soldier) => soldier.kind))).toEqual(
      new Set(["claude-code", "openclaw"]),
    );
  });

  it("makes a hero of every member, running or not", () => {
    const roster = rosterFrom([], [member("ada"), member("grace")], { uid: "ada" });
    expect(roster.heroes.map((hero) => hero.uid)).toEqual(["ada", "grace"]);
    expect(roster.soldiers).toHaveLength(0);
  });

  it("makes a hero of somebody who has left but whose session is still up", () => {
    /*
     * Otherwise that session's soldier stands in open country with nobody to
     * follow. The name says what happened rather than pretending they are on
     * the team.
     */
    const roster = rosterFrom(
      [session({ ownerUid: "departed", command: "claude" })],
      [member("ada")],
      { uid: "ada" },
    );
    expect(roster.heroes.map((hero) => hero.uid).sort()).toEqual(["ada", "departed"]);
    expect(roster.heroes.find((hero) => hero.uid === "departed")?.name).toContain("left the team");
  });

  it("leaves closed sessions off the field", () => {
    /*
     * A closed session is work that is finished. It counts towards experience,
     * which the service works out separately; it does not stand on the field.
     */
    const roster = rosterFrom(
      [
        session({ ownerUid: "ada", command: "claude" }),
        session({ ownerUid: "ada", command: "claude", closedAt: 2000 }),
      ],
      [member("ada")],
      { uid: "ada" },
    );
    expect(roster.soldiers).toHaveLength(1);
  });

  it("draws your own hero as the class you chose", () => {
    /*
     * Your choice lives in your own saved game and only this browser can read
     * it, so it wins for your own hero and nobody else's. A colleague is drawn
     * as the harness they run most, which is the only thing about them that is
     * both visible and true.
     */
    const roster = rosterFrom(
      [
        session({ ownerUid: "ada", command: "claude" }),
        session({ ownerUid: "grace", command: "claude" }),
      ],
      [member("ada"), member("grace")],
      { uid: "ada" },
      "hermes",
    );
    expect(roster.heroes.find((hero) => hero.uid === "ada")?.characterClass).toBe("hermes");
    expect(roster.heroes.find((hero) => hero.uid === "grace")?.characterClass).toBe("claude-code");
  });

  it("falls back to what you run when you have chosen nothing", () => {
    const roster = rosterFrom(
      [session({ ownerUid: "ada", command: "codex" })],
      [member("ada")],
      { uid: "ada" },
      "",
    );
    expect(roster.heroes[0].characterClass).toBe("codex");
  });

  it("marks which hero is yours", () => {
    const roster = rosterFrom([], [member("ada"), member("grace")], { uid: "grace" });
    expect(roster.youUid).toBe("grace");
  });

  it("names a soldier after the session, falling back to the command", () => {
    const roster = rosterFrom(
      [
        session({ ownerUid: "ada", name: "fix: audit seal", command: "claude" }),
        session({ ownerUid: "ada", command: "npm run dev" }),
      ],
      [member("ada")],
      { uid: "ada" },
    );
    expect(roster.soldiers.map((soldier) => soldier.name).sort()).toEqual([
      "fix: audit seal",
      "npm run dev",
    ]);
  });

  it("reads a soldier's work from its name before its command", () => {
    const roster = rosterFrom(
      [session({ ownerUid: "ada", name: "fix: the thing", command: "claude" })],
      [member("ada")],
      { uid: "ada" },
    );
    expect(roster.soldiers[0].work).toBe("bug");
  });

  it("gives each soldier the session facts the panel needs", () => {
    const roster = rosterFrom(
      [session({ ownerUid: "ada", command: "claude", host: "workshop", startedAt: 4242 })],
      [member("ada")],
      { uid: "ada" },
    );
    expect(roster.soldiers[0].session).toMatchObject({ host: "workshop", startedAt: 4242 });
  });

  it("puts the heroes in a stable order", () => {
    /* So that a camp does not move because the service replied differently. */
    const members = [member("grace"), member("ada"), member("alan")];
    const first = rosterFrom([], members, { uid: "ada" });
    const again = rosterFrom([], [...members].reverse(), { uid: "ada" });
    expect(again.heroes.map((hero) => hero.uid)).toEqual(first.heroes.map((hero) => hero.uid));
  });
});

describe("what the field will draw", () => {
  /**
   * The caps exist so a large organisation cannot exhaust a browser: every
   * figure costs a container, a sprite and a name board, and a name board is a
   * texture. What they must never do is take the player off their own map, or
   * make a team's own statistics wrong to protect its GPU.
   */
  const bigTeam = (people: number, each: number) => {
    const members = Array.from({ length: people }, (_, index) => ({
      uid: `member-${index}`,
      email: `person${index}@example.com`,
    }));
    const sessions = members.flatMap((member, index) =>
      Array.from({ length: each }, (_, session) => ({
        id: `s-${index}-${session}`,
        name: `feat: thing ${session}`,
        command: "claude",
        host: "laptop",
        startedAt: Date.now(),
        ownerUid: member.uid,
        status: "running",
      })),
    );
    return { members, sessions };
  };

  it("draws no more than the ceiling, however large the team", () => {
    const { members, sessions } = bigTeam(60, 20);
    const roster = rosterFrom(sessions as never, members as never, { uid: "member-7" });
    expect(roster.soldiers.length).toBeLessThanOrEqual(240);
    expect(roster.heroes.length).toBeLessThanOrEqual(60);
  });

  it("still reports the whole team, which is the read-out", () => {
    const { members, sessions } = bigTeam(60, 20);
    const roster = rosterFrom(sessions as never, members as never, { uid: "member-7" });
    expect(roster.soldierTotal).toBe(1200);
    expect(roster.heroTotal).toBe(60);
  });

  it("never drops your own company to make room", () => {
    const { members, sessions } = bigTeam(60, 20);
    const roster = rosterFrom(sessions as never, members as never, { uid: "member-59" });
    expect(roster.heroes.some((hero) => hero.uid === "member-59")).toBe(true);
    expect(roster.soldiers.some((soldier) => soldier.heroUid === "member-59")).toBe(true);
  });

  it("does not let one person fill the field", () => {
    const members = [{ uid: "hog", email: "hog@example.com" }, { uid: "quiet", email: "q@example.com" }];
    const sessions = Array.from({ length: 300 }, (_, index) => ({
      id: `s-${index}`,
      name: "feat: thing",
      command: "claude",
      host: "laptop",
      startedAt: Date.now(),
      ownerUid: "hog",
      status: "running",
    }));
    const roster = rosterFrom(sessions as never, members as never, { uid: "quiet" });
    const hogs = roster.soldiers.filter((soldier) => soldier.heroUid === "hog").length;
    expect(hogs).toBeLessThanOrEqual(14);
  });
});
