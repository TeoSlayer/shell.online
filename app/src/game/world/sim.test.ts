import { describe, expect, it } from "vitest";
import { GARRISONS } from "./marches";
import { assignCamps, CAMP_RADIUS, campSites } from "./camps";
import {
  besieged,
  createSim,
  marchTargets,
  garrisonSoldiers,
  orderHero,
  setRoster,
  tickSim,
  yourHero,
  type Sim,
  type Work,
} from "./sim";

/**
 * The simulation, run deep and looked at.
 *
 * Most of this is about one sentence: a hero is a person, a soldier is a
 * session, and a soldier belongs to the hero who owns it. The rest is about the
 * shaking -- a wright that reverses direction thirty times a second looks like a
 * rendering fault and is not one, and the only way to tell is to run the numbers
 * without Pixi in the way and count.
 */

const session = (id: string) => ({
  id,
  startedAt: Date.now(),
  host: "laptop",
  command: "npm run dev",
});

/** One person with ten Claude sessions and three OpenClaw ones: the worked example. */
function theExample(): Sim {
  const sim = createSim();
  setRoster(sim, {
    heroes: [{ uid: "ada", name: "Ada", characterClass: "claude-code" }],
    soldiers: [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `claude-${index}`,
        name: `claude ${index}`,
        kind: "claude-code",
        work: "feature" as Work,
        heroUid: "ada",
        session: session(`claude-${index}`),
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `claw-${index}`,
        name: `claw ${index}`,
        kind: "openclaw",
        work: "idle" as Work,
        heroUid: "ada",
        session: session(`claw-${index}`),
      })),
    ],
    youUid: "ada",
  });
  return sim;
}

function run(sim: Sim, ticks: number): Sim {
  for (let index = 0; index < ticks; index += 1) tickSim(sim);
  return sim;
}

describe("the camps", () => {
  it("finds somewhere for everybody to hold", () => {
    expect(campSites().length).toBeGreaterThan(6);
  });

  it("never puts a camp in a holding", () => {
    for (const camp of campSites()) {
      for (const garrison of GARRISONS) {
        expect(Math.hypot(camp.x - garrison.x, camp.y - garrison.y))
          .toBeGreaterThan(garrison.radius + CAMP_RADIUS);
      }
    }
  });

  it("never puts two camps on the same ground", () => {
    /*
     * Two heroes handed one spot reads as a rendering fault rather than as a
     * crowded team, which is why camps are assigned for the whole roster at
     * once instead of one hash at a time.
     */
    const sites = campSites();
    for (let first = 0; first < sites.length; first += 1) {
      for (let second = first + 1; second < sites.length; second += 1) {
        expect(Math.hypot(sites[first].x - sites[second].x, sites[first].y - sites[second].y))
          .toBeGreaterThan(CAMP_RADIUS * 2);
      }
    }
  });

  it("gives every member their own ground", () => {
    const uids = Array.from({ length: 8 }, (_, index) => `member-${index}`);
    const camps = assignCamps(uids);
    const seen = new Set(([...camps.values()]).map((camp) => `${camp.x},${camp.y}`));
    expect(seen.size).toBe(uids.length);
  });

  it("gives the same member the same ground every time", () => {
    const uids = ["ada", "grace", "alan"];
    const first = assignCamps(uids);
    const again = assignCamps([...uids].reverse());
    for (const uid of uids) expect(again.get(uid)).toEqual(first.get(uid));
  });
});

describe("heroes and their soldiers", () => {
  it("gives one person thirteen soldiers of two classes", () => {
    /* The worked example from the specification, asserted. */
    const sim = theExample();
    const soldiers = sim.actors.filter((actor) => actor.role === "soldier");
    expect(soldiers).toHaveLength(13);
    expect(soldiers.every((soldier) => soldier.heroUid === "ada")).toBe(true);
    expect(new Set(soldiers.map((soldier) => soldier.kind))).toEqual(
      new Set(["claude-code", "openclaw"]),
    );
  });

  it("keeps a hero on the field with nothing running", () => {
    /* A colleague with nothing open is still on the team. */
    const sim = createSim();
    setRoster(sim, { heroes: [{ uid: "ada", name: "Ada", characterClass: "codex" }], soldiers: [] });
    expect(sim.actors.filter((actor) => actor.role === "hero")).toHaveLength(1);
  });

  it("starts every soldier at its own hero's camp", () => {
    const sim = theExample();
    const camp = sim.camps.get("ada")!;
    for (const soldier of sim.actors.filter((actor) => actor.role === "soldier")) {
      expect(Math.hypot(soldier.x - camp.x, soldier.y - camp.y)).toBeLessThanOrEqual(CAMP_RADIUS);
    }
  });

  it("keeps two people's retinues apart", () => {
    const sim = createSim();
    setRoster(sim, {
      heroes: [
        { uid: "ada", name: "Ada", characterClass: "codex" },
        { uid: "alan", name: "Alan", characterClass: "openclaw" },
      ],
      soldiers: [
        { id: "a", name: "a", kind: "codex", work: "idle", heroUid: "ada" },
        { id: "b", name: "b", kind: "openclaw", work: "idle", heroUid: "alan" },
      ],
    });
    run(sim, 600);

    const ada = sim.actors.find((actor) => actor.id === "soldier-a")!;
    const alan = sim.actors.find((actor) => actor.id === "soldier-b")!;
    const adaCamp = sim.camps.get("ada")!;
    const alanCamp = sim.camps.get("alan")!;
    expect(Math.hypot(ada.x - adaCamp.x, ada.y - adaCamp.y)).toBeLessThan(CAMP_RADIUS + 3);
    expect(Math.hypot(alan.x - alanCamp.x, alan.y - alanCamp.y)).toBeLessThan(CAMP_RADIUS + 3);
  });

  it("takes the same roster twice without doubling anybody", () => {
    /*
     * The poll depends on this. The roster arrives every four seconds and is
     * usually identical; before `setRoster` was idempotent the field filled up
     * with copies of everybody.
     */
    const sim = theExample();
    const before = sim.actors.length;
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "claude-code" }],
      soldiers: sim.actors
        .filter((actor) => actor.role === "soldier")
        .map((actor) => ({
          id: actor.id.replace("soldier-", ""),
          name: actor.name,
          kind: actor.kind,
          work: actor.work,
          heroUid: "ada",
        })),
      youUid: "ada",
    });
    expect(sim.actors).toHaveLength(before);
  });

  it("leaves people standing where they were when the roster repeats", () => {
    const sim = theExample();
    run(sim, 200);
    const before = sim.actors.map((actor) => `${actor.id}:${actor.x.toFixed(3)}`);
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "claude-code" }],
      soldiers: sim.actors
        .filter((actor) => actor.role === "soldier")
        .map((actor) => ({
          id: actor.id.replace("soldier-", ""),
          name: actor.name,
          kind: actor.kind,
          work: actor.work,
          heroUid: "ada",
        })),
      youUid: "ada",
    });
    expect(sim.actors.map((actor) => `${actor.id}:${actor.x.toFixed(3)}`)).toEqual(before);
  });

  it("dismisses a soldier whose session has gone", () => {
    const sim = theExample();
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "claude-code" }],
      soldiers: [],
      youUid: "ada",
    });
    expect(sim.actors.filter((actor) => actor.role === "soldier")).toHaveLength(0);
    expect(sim.actors.filter((actor) => actor.role === "hero")).toHaveLength(1);
  });

  it("marches a finished session to the Barrow rather than blinking it out", () => {
    /*
     * A session ending is the most important thing that happens in this game --
     * it is where the experience comes from -- and a figure that vanishes is
     * the one way of showing that which says nothing at all.
     */
    const sim = theExample();
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "claude-code" }],
      soldiers: [],
      youUid: "ada",
    });

    const marching = sim.actors.filter((actor) => actor.role === "fallen");
    expect(marching).toHaveLength(13);
    expect(sim.finished).toBe(13);

    const barrow = GARRISONS.find((holding) => holding.id === "barrow")!;
    for (const one of marching) {
      expect(one.toX).toBe(barrow.x);
      expect(one.toY).toBe(barrow.y);
    }
  });

  it("takes them off the field once they arrive", () => {
    const sim = theExample();
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "claude-code" }],
      soldiers: [],
      youUid: "ada",
    });
    run(sim, 3000);
    expect(sim.actors.filter((actor) => actor.role === "fallen")).toHaveLength(0);
    expect(sim.actors.filter((actor) => actor.role === "hero")).toHaveLength(1);
  });

  it("does not bring the finished back", () => {
    /* A session that finished stays finished; only the living are set back up. */
    const sim = theExample();
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "claude-code" }],
      soldiers: [],
      youUid: "ada",
    });
    run(sim, 6000);
    expect(sim.actors.filter((actor) => actor.role === "soldier")).toHaveLength(0);
  });

  it("does not dismiss the watch along with the roster", () => {
    const sim = theExample();
    garrisonSoldiers(sim);
    const watch = sim.actors.filter((actor) => actor.role === "watch").length;
    setRoster(sim, { heroes: [], soldiers: [] });
    expect(sim.actors.filter((actor) => actor.role === "watch")).toHaveLength(watch);
  });
});

describe("following", () => {
  it("brings the retinue along when the hero is sent somewhere", () => {
    /*
     * The point of the whole arrangement. Soldiers are not in formation -- they
     * notice after a few paces and then hurry, which reads as people following
     * somebody rather than as a parade.
     */
    const sim = theExample();
    const camp = sim.camps.get("ada")!;
    run(sim, 60);

    orderHero(sim, camp.x + 22, camp.y + 10);
    run(sim, 900);

    const hero = yourHero(sim)!;
    const soldiers = sim.actors.filter((actor) => actor.role === "soldier");
    const near = soldiers.filter(
      (soldier) => Math.hypot(soldier.x - hero.x, soldier.y - hero.y) < CAMP_RADIUS + 4,
    );
    expect(near.length).toBeGreaterThan(soldiers.length / 2);
  });

  it("puts the hero where it was told, and leaves them there", () => {
    /*
     * Two claims, and the second is the one that was broken. A hero used to
     * walk to where they were sent, arrive, notice they were a long way from
     * their camp and walk straight back -- which makes the one thing the player
     * can do in this game pointless. Where they were sent becomes where they
     * hold.
     *
     * The tolerance is a camp's width rather than a pixel because a hero
     * standing exactly still on the spot they were sent to is a statue. They
     * arrive and then mill about it, which is what everybody else does too.
     */
    const sim = theExample();
    const camp = sim.camps.get("ada")!;
    orderHero(sim, camp.x + 12, camp.y - 6);
    run(sim, 600);

    const hero = yourHero(sim)!;
    expect(hero.station).toEqual({ x: camp.x + 12, y: camp.y - 6 });
    expect(Math.hypot(hero.x - (camp.x + 12), hero.y - (camp.y - 6))).toBeLessThan(CAMP_RADIUS);
    expect(Math.hypot(hero.x - camp.x, hero.y - camp.y)).toBeGreaterThan(CAMP_RADIUS);
  });

  it("refuses to order anybody else's hero", () => {
    /*
     * Marching a colleague around the map would be a toy, and the only thing in
     * this game that changes what somebody else sees.
     */
    const sim = createSim();
    setRoster(sim, {
      heroes: [{ uid: "grace", name: "Grace", characterClass: "codex" }],
      soldiers: [],
      /* No `youUid`: the viewer is not on this team. */
    });
    expect(orderHero(sim, 10, 10)).toBe(false);
    expect(sim.actors.every((actor) => !actor.ordered)).toBe(true);
  });
});

describe("the Unmade", () => {
  it("comes for a hero whose session is on a fault", () => {
    const sim = createSim();
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "codex" }],
      soldiers: [{ id: "a", name: "fix: it", kind: "codex", work: "bug", heroUid: "ada" }],
      youUid: "ada",
    });
    expect(besieged(sim)).toEqual(["ada"]);
    run(sim, 300);
    expect(sim.spawned).toBeGreaterThan(0);
  });

  it("shows a soldier building, so feature work is not invisible", () => {
    /*
     * A map where only broken things move would quietly teach everybody that
     * only broken things count.
     */
    const sim = theExample();
    run(sim, 300);
    expect(sim.raised).toBeGreaterThan(0);
  });

  it("comes for a kingdom where nobody is fixing anything", () => {
    /*
     * The bug this replaces: the wave came only for a hero whose session was
     * on a fault, work is read from what somebody called their session, and
     * most sessions are called `npm run dev` -- so on a real team nothing ever
     * arrived and the map showed empty grass. The Unmade stand against the
     * kingdom, not against a naming convention.
     */
    const sim = theExample();
    run(sim, 600);
    expect(sim.actors.some((actor) => actor.side === "unmade")).toBe(true);
  });

  it("sends a wave that grows with the team", () => {
    /*
     * More people is more border to hold. What holds it is sessions, which is
     * the whole of the incentive.
     */
    const small = createSim();
    setRoster(small, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "codex" }],
      soldiers: [],
    });
    const large = createSim();
    setRoster(large, {
      heroes: Array.from({ length: 6 }, (_, index) => ({
        uid: `hero-${index}`,
        name: `Hero ${index}`,
        characterClass: "codex",
      })),
      soldiers: [],
    });
    run(small, 4000);
    run(large, 4000);

    const count = (sim: Sim) => sim.actors.filter((actor) => actor.side === "unmade").length;
    expect(count(large)).toBeGreaterThan(count(small));
  });


  it("comes to a camp, and to the one on a fault hardest", () => {
    /*
     * Everybody's ground is walked on; the person actually fixing something
     * gets the larger share of it, because that is where the work is and the
     * map should say so.
     */
    const sim = createSim();
    setRoster(sim, {
      heroes: [
        { uid: "ada", name: "Ada", characterClass: "codex" },
        { uid: "alan", name: "Alan", characterClass: "codex" },
      ],
      soldiers: [
        { id: "a", name: "fix: it", kind: "codex", work: "bug", heroUid: "ada" },
        { id: "b", name: "npm run dev", kind: "codex", work: "idle", heroUid: "alan" },
      ],
      youUid: "ada",
    });
    expect(marchTargets(sim)).toEqual(["ada", "ada", "ada", "alan"]);

    run(sim, 400);
    const unmade = sim.actors.filter((actor) => actor.side === "unmade");
    expect(unmade.length).toBeGreaterThan(0);
    for (const foe of unmade) {
      /* Nobody wanders: every one of them is walking to somebody's camp. */
      const camp = sim.camps.get(foe.heroUid ?? "")!;
      expect(camp).toBeDefined();
      expect(Math.hypot(foe.x - camp.x, foe.y - camp.y)).toBeLessThan(30);
    }
    const atAda = unmade.filter((foe) => foe.heroUid === "ada").length;
    const atAlan = unmade.filter((foe) => foe.heroUid === "alan").length;
    expect(atAda).toBeGreaterThan(atAlan);
  });

  it("is bounded however long it runs", () => {
    const sim = createSim();
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "codex" }],
      soldiers: [{ id: "a", name: "fix: it", kind: "codex", work: "bug", heroUid: "ada" }],
      youUid: "ada",
    });
    run(sim, 6000);
    expect(sim.actors.filter((actor) => actor.side === "unmade").length).toBeLessThanOrEqual(40);
  });

  it("does not throw the whole wave at one camp", () => {
    /*
     * A team where one person is fixing everything drew every foe on the map,
     * and everybody else's camp stayed quiet. Each camp takes a share.
     */
    const sim = createSim();
    setRoster(sim, {
      heroes: [
        { uid: "ada", name: "Ada", characterClass: "codex" },
        { uid: "alan", name: "Alan", characterClass: "codex" },
      ],
      soldiers: [
        { id: "a", name: "fix: it", kind: "codex", work: "bug", heroUid: "ada" },
        { id: "b", name: "fix: that", kind: "codex", work: "bug", heroUid: "alan" },
      ],
      youUid: "ada",
    });
    run(sim, 2000);

    const atAda = sim.actors.filter((a) => a.side === "unmade" && a.heroUid === "ada").length;
    const atAlan = sim.actors.filter((a) => a.side === "unmade" && a.heroUid === "alan").length;
    expect(atAda).toBeLessThanOrEqual(7);
    expect(atAlan).toBeLessThanOrEqual(7);
  });

  it("gets felled, and the count says so", () => {
    const sim = createSim();
    garrisonSoldiers(sim);
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "codex" }],
      soldiers: Array.from({ length: 4 }, (_, index) => ({
        id: `a${index}`,
        name: "fix: it",
        kind: "codex",
        work: "bug" as Work,
        heroUid: "ada",
      })),
      youUid: "ada",
    });
    run(sim, 3000);
    expect(sim.felled).toBeGreaterThan(0);
  });

  it("never kills anybody who stands for something real", () => {
    /*
     * A hero is a person and a soldier is a running session. Neither stops
     * existing because something bit it: they are set back on their feet at
     * their camp, which reads as being driven off. Only the Unmade die.
     */
    const sim = createSim();
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "codex" }],
      soldiers: [{ id: "a", name: "fix: it", kind: "codex", work: "bug", heroUid: "ada" }],
      youUid: "ada",
    });
    run(sim, 4000);
    expect(sim.actors.filter((actor) => actor.role === "hero")).toHaveLength(1);
    expect(sim.actors.filter((actor) => actor.role === "soldier")).toHaveLength(1);
  });
});

describe("running", () => {
  it("moves people when it is ticked", () => {
    const sim = theExample();
    const before = sim.actors.map((actor) => `${actor.x},${actor.y}`);
    run(sim, 120);
    expect(sim.actors.map((actor) => `${actor.x},${actor.y}`)).not.toEqual(before);
  });

  it("does not shake", () => {
    /*
     * The bug this whole file was written for. A wright that cannot reach where
     * it is going re-decides every tick and spends its life turning round; on
     * screen that reads as violent vibration. Counting direction reversals is
     * how it was found and the only honest way to say it is gone.
     */
    const sim = theExample();
    garrisonSoldiers(sim);
    const TICKS = 900;
    const facing = new Map(sim.actors.map((actor) => [actor.id, actor.facing]));
    const reversals = new Map(sim.actors.map((actor) => [actor.id, 0]));

    for (let index = 0; index < TICKS; index += 1) {
      tickSim(sim);
      for (const actor of sim.actors) {
        const was = facing.get(actor.id);
        if (was !== undefined && was !== actor.facing) {
          reversals.set(actor.id, (reversals.get(actor.id) ?? 0) + 1);
        }
        facing.set(actor.id, actor.facing);
      }
    }

    expect(Math.max(...reversals.values())).toBeLessThan(TICKS / 20);
  });

  it("keeps everybody on the map", () => {
    const sim = theExample();
    garrisonSoldiers(sim);
    run(sim, 1200);
    for (const actor of sim.actors) {
      expect(Number.isFinite(actor.x)).toBe(true);
      expect(Number.isFinite(actor.y)).toBe(true);
      expect(actor.x).toBeGreaterThan(-8);
      expect(actor.y).toBeGreaterThan(-8);
    }
  });

  it("never reports an action it cannot draw", () => {
    const sim = theExample();
    garrisonSoldiers(sim);
    for (let index = 0; index < 900; index += 1) {
      tickSim(sim);
      for (const actor of sim.actors) {
        expect(["stand", "walk", "attack"]).toContain(actor.action);
        expect(actor.hp).toBeGreaterThan(0);
        expect(actor.hp).toBeLessThanOrEqual(actor.maxHp);
      }
    }
  });

  it("clears its own effects rather than growing forever", () => {
    const sim = createSim();
    garrisonSoldiers(sim);
    setRoster(sim, {
      heroes: [{ uid: "ada", name: "Ada", characterClass: "codex" }],
      soldiers: Array.from({ length: 4 }, (_, index) => ({
        id: `a${index}`,
        name: "fix: it",
        kind: "codex",
        work: "bug" as Work,
        heroUid: "ada",
      })),
      youUid: "ada",
    });
    run(sim, 3000);
    expect(sim.effects.length).toBeLessThan(200);
    expect(sim.marks.length).toBeLessThan(200);
  });
});
