import { describe, expect, it } from "vitest";
import { GARRISONS, garrisonFor } from "./marches";
import { createSim, garrisonSoldiers, muster, tickSim, type Sim, type Work } from "./sim";

/**
 * The simulation, run deep and looked at.
 *
 * This file exists because the shaking did. A wright that reverses direction
 * thirty times a second looks like a rendering fault and is not one, and the
 * only way to tell the difference is to run the numbers without Pixi in the
 * way and count. `sim.ts` has no imports from the renderer for exactly this
 * reason, so a thousand ticks here cost nothing.
 */

const session = (id: string) => ({
  id,
  startedAt: Date.now(),
  host: "laptop",
  command: "npm run dev",
});

function fieldOf(count: number, work: Work = "bug"): Sim {
  const sim = createSim();
  garrisonSoldiers(sim);
  for (let index = 0; index < count; index += 1) {
    muster(sim, {
      id: `wright-${index}`,
      name: `wright ${index}`,
      kind: "claude-code",
      work,
      session: session(`wright-${index}`),
    });
  }
  return sim;
}

function run(sim: Sim, ticks: number): Sim {
  for (let index = 0; index < ticks; index += 1) tickSim(sim);
  return sim;
}

describe("mustering", () => {
  it("puts a wright at the garrison its work belongs to", () => {
    const sim = createSim();
    const fighting = muster(sim, { id: "a", name: "a", kind: "codex", work: "bug" });
    const building = muster(sim, { id: "b", name: "b", kind: "codex", work: "feature" });

    const forFighting = garrisonFor("bug");
    const forBuilding = garrisonFor("feature");
    expect(Math.hypot(fighting.x - forFighting.x, fighting.y - forFighting.y))
      .toBeLessThanOrEqual(forFighting.radius + 4);
    expect(Math.hypot(building.x - forBuilding.x, building.y - forBuilding.y))
      .toBeLessThanOrEqual(forBuilding.radius + 4);
  });

  it("musters the same session only once", () => {
    /*
     * The roster is polled and the scene can be rebuilt -- React remounts an
     * effect in development -- so `muster` is called repeatedly with ids that
     * are already on the field. Before this held, every one of those put a
     * second copy of the same wright on the map, and the field filled up with
     * duplicates that fought beside themselves.
     */
    const sim = createSim();
    const first = muster(sim, { id: "a", name: "a", kind: "codex", work: "bug" });
    const again = muster(sim, { id: "a", name: "a", kind: "codex", work: "bug" });

    expect(sim.actors).toHaveLength(1);
    expect(again).toBe(first);
  });

  it("raises the watch only once, however often it is asked", () => {
    const sim = createSim();
    garrisonSoldiers(sim);
    const after = sim.actors.length;
    garrisonSoldiers(sim);
    expect(sim.actors).toHaveLength(after);
  });

  it("gives every garrison somebody to stand in it", () => {
    const sim = createSim();
    garrisonSoldiers(sim);
    for (const garrison of GARRISONS) {
      expect(sim.actors.some((actor) => actor.home === garrison.id)).toBe(true);
    }
  });
});

describe("running", () => {
  it("moves people when it is ticked", () => {
    const sim = fieldOf(4);
    const before = sim.actors.map((actor) => `${actor.x},${actor.y}`);
    run(sim, 120);
    const after = sim.actors.map((actor) => `${actor.x},${actor.y}`);
    expect(after).not.toEqual(before);
  });

  it("does not shake", () => {
    /*
     * The bug this whole file was written for. A wright that cannot reach where
     * it is going re-decides every tick and spends its life turning round; on
     * screen that reads as violent vibration. Counting direction reversals is
     * how it was found and is the only honest way to say it is gone.
     *
     * Walking a curved path reverses facing occasionally, so the bar is not
     * zero. It is "far less often than every other tick", which is where the
     * broken version sat.
     */
    const sim = fieldOf(6);
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

    const worst = Math.max(...reversals.values());
    expect(worst).toBeLessThan(TICKS / 20);
  });

  it("keeps everybody inside the country", () => {
    const sim = fieldOf(6);
    run(sim, 1200);
    for (const actor of sim.actors) {
      expect(Number.isFinite(actor.x)).toBe(true);
      expect(Number.isFinite(actor.y)).toBe(true);
      expect(actor.x).toBeGreaterThan(-8);
      expect(actor.y).toBeGreaterThan(-8);
    }
  });

  it("keeps a wright near the garrison it belongs to", () => {
    /* Milling about is the intent; wandering off across the map is not. */
    const sim = fieldOf(4, "feature");
    run(sim, 1200);
    const home = garrisonFor("feature");
    for (const actor of sim.actors) {
      if (!actor.session) continue;
      expect(Math.hypot(actor.x - home.x, actor.y - home.y))
        .toBeLessThanOrEqual(home.radius + 6);
    }
  });
});

describe("the Unmade", () => {
  it("arrives when there is a fault being worked on", () => {
    const sim = fieldOf(3, "bug");
    run(sim, 600);
    expect(sim.spawned).toBeGreaterThan(0);
  });

  it("stays away when nobody is fighting anything", () => {
    /*
     * The enemy is a consequence of the work, not a timer. An account with
     * nothing broken should show a quiet map, because that is the truth.
     */
    const sim = createSim();
    garrisonSoldiers(sim);
    muster(sim, { id: "a", name: "a", kind: "codex", work: "feature" });
    run(sim, 600);
    expect(sim.actors.some((actor) => actor.side === "unmade")).toBe(false);
  });

  it("is bounded, however long it runs", () => {
    const sim = fieldOf(6, "bug");
    run(sim, 6000);
    expect(sim.actors.filter((actor) => actor.side === "unmade").length)
      .toBeLessThanOrEqual(14);
  });

  it("gets felled, and the count says so", () => {
    const sim = fieldOf(6, "bug");
    run(sim, 3000);
    expect(sim.felled).toBeGreaterThan(0);
  });
});

describe("what the renderer reads", () => {
  it("clears its own effects and marks rather than growing forever", () => {
    /*
     * Every effect is a pooled sprite on the other side of this. A list that
     * only grows is a leak that shows up as a frame rate, hours in.
     */
    const sim = fieldOf(6, "bug");
    run(sim, 3000);
    expect(sim.effects.length).toBeLessThan(200);
    expect(sim.marks.length).toBeLessThan(200);
  });

  it("never reports an action it cannot draw", () => {
    const sim = fieldOf(6, "bug");
    for (let index = 0; index < 900; index += 1) {
      tickSim(sim);
      for (const actor of sim.actors) {
        expect(["stand", "walk", "attack"]).toContain(actor.action);
        expect(actor.hp).toBeGreaterThan(0);
        expect(actor.hp).toBeLessThanOrEqual(actor.maxHp);
      }
    }
  });
});
