import { describe, expect, it } from "vitest";
import type { Member, SessionRecord } from "../../lib/api";
import { rosterFrom } from "./sessions";
import { kingdomStrength, veilOpacity, waveSize } from "../world/kingdom";
import { createSim, setRoster, tickSim, type Sim } from "../world/sim";

/**
 * The field a real team gets, from the rows the service really returns.
 *
 * Everything else about the game is tested a layer at a time, and the layers
 * are honest; what was missing is the join. The map somebody actually looks at
 * comes from `GET /api/sessions` through `rosterFrom`, into `setRoster`, and
 * out as figures and a wave -- and until now the only roster ever pushed
 * through all three in a test was the stand-in garrison, which is the one
 * roster no account has. Every defect this game shipped with lived in that
 * gap: sessions that had finished standing as soldiers, and a wave that never
 * came because nobody had named a session after a bug.
 */

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: `s-${Math.random().toString(36).slice(2)}`,
  shareUrl: "https://example.invalid/s",
  command: "claude",
  readOnly: false,
  encrypted: true,
  persistent: false,
  host: "laptop",
  startedAt: Date.now() - 60_000,
  relayStatus: "connected",
  ...over,
});

const member = (uid: string): Member => ({
  orgId: "org-1",
  uid,
  email: `${uid}@example.invalid`,
  name: uid,
  role: "member",
  joinedAt: 1000,
});

const run = (sim: Sim, ticks: number) => {
  for (let tick = 0; tick < ticks; tick += 1) tickSim(sim);
};

const count = (sim: Sim, side: "garrison" | "unmade", role?: string) =>
  sim.actors.filter((actor) => actor.side === side && (!role || actor.role === role)).length;

describe("the field a working team gets", () => {
  /*
   * An ordinary morning: four people, nine session rows, and only five of
   * those rows are work anybody can still type into.
   */
  const members = ["ada", "grace", "alan", "edsger"].map(member);
  const sessions: SessionRecord[] = [
    session({ ownerUid: "ada", name: "claude" }),
    session({ ownerUid: "ada", name: "npm run dev", command: "npm run dev" }),
    session({ ownerUid: "grace", name: "codex", command: "codex" }),
    session({ ownerUid: "grace", name: "review", relayStatus: "disconnected", hostLastSeenAt: Date.now() - 20_000 }),
    session({ ownerUid: "alan", name: "openclaw", command: "openclaw" }),
    /* Finished, in each of the ways a session finishes. */
    session({ ownerUid: "ada", name: "yesterday", closedAt: Date.now() - 3_600_000 }),
    session({ ownerUid: "grace", name: "exited", relayStatus: "exited" }),
    session({ ownerUid: "alan", name: "rebooted", relayStatus: "disconnected", hostLastSeenAt: Date.now() - 3_600_000 }),
    /* And one being watched rather than worked in. */
    session({ ownerUid: "edsger", name: "demo to the team", readOnly: true }),
  ];

  it("musters a soldier for the live writable sessions and nobody else", () => {
    const roster = rosterFrom(sessions, members, { uid: "ada" });
    expect(roster.soldierTotal).toBe(5);
    expect(roster.heroTotal).toBe(4);

    const sim = createSim();
    setRoster(sim, roster);
    expect(count(sim, "garrison", "hero")).toBe(4);
    expect(count(sim, "garrison", "soldier")).toBe(5);
  });

  it("sends the Unmade even though nobody named a session after a bug", () => {
    /*
     * The defect this replaces, in the shape it actually had: not one of these
     * nine sessions reads as bug work, because people call their sessions
     * `claude` and `npm run dev`. The map used to be empty grass for weeks.
     */
    const roster = rosterFrom(sessions, members, { uid: "ada" });
    const sim = createSim();
    setRoster(sim, roster);
    run(sim, 600);

    expect(count(sim, "unmade")).toBeGreaterThan(0);
    /* Every one of them is walking to a camp that exists. */
    for (const foe of sim.actors.filter((actor) => actor.side === "unmade")) {
      expect(sim.camps.get(foe.heroUid ?? "")).toBeDefined();
    }
  });

  it("holds the border at four people with eight sessions, and not at five", () => {
    const roster = rosterFrom(sessions, members, { uid: "ada" });
    const short = kingdomStrength({ heroes: roster.heroTotal, soldiers: roster.soldierTotal });
    expect(short.struggling).toBe(true);
    expect(short.short).toBe(3);
    expect(veilOpacity(short.strain)).toBeGreaterThan(0);

    const held = kingdomStrength({ heroes: roster.heroTotal, soldiers: 8 });
    expect(held.struggling).toBe(false);
    expect(veilOpacity(held.strain)).toBe(0);
  });

  it("brings the wave with the team rather than with the work", () => {
    expect(waveSize(4)).toBeGreaterThan(waveSize(1));
  });
});

describe("a team large enough to be worth thinking about", () => {
  /*
   * Twenty people and fifteen live sessions, which is a healthy Tuesday for an
   * organisation of that size and is nonetheless a kingdom the rule calls
   * short: two a head wants forty.
   *
   * Written down rather than argued about. The rule is deliberate -- the game
   * asks for a session per person per thing they are doing -- and this is what
   * it means at scale, so that changing it later is a decision somebody takes
   * against a number rather than a surprise somebody discovers on a screen.
   */
  it("reads twenty people with fifteen sessions as short-handed", () => {
    const members = Array.from({ length: 20 }, (_, index) => member(`m${index}`));
    const sessions = Array.from({ length: 15 }, (_, index) =>
      session({ ownerUid: `m${index}`, name: "claude" }),
    );
    const roster = rosterFrom(sessions, members, { uid: "m0" });
    const strength = kingdomStrength({ heroes: roster.heroTotal, soldiers: roster.soldierTotal });

    expect(strength.wanted).toBe(40);
    expect(strength.short).toBe(25);
    expect(strength.strain).toBeCloseTo(0.625);
    /* Visible, and a long way from the ceiling. */
    expect(veilOpacity(strength.strain)).toBeGreaterThan(0.2);
    expect(veilOpacity(strength.strain)).toBeLessThan(0.3);
  });

  it("caps what that costs the browser", () => {
    /* The wave a kingdom of twenty would want is bounded, whatever the rule. */
    expect(waveSize(20)).toBeLessThanOrEqual(40);
  });
});
