import { describe, expect, it } from "vitest";
import { createWorld, dismiss, muster, tickWorld, type World } from "./world";

const YARD = { left: 2, top: 2, right: 10, bottom: 8 };

function garrison(count: number): World {
  const world = createWorld(YARD);
  for (let index = 0; index < count; index += 1) {
    muster(world, {
      id: `w${index}`,
      name: `session ${index}`,
      kind: "terminal",
      work: "idle",
    });
  }
  return world;
}

function run(world: World, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) tickWorld(world);
}

describe("mustering", () => {
  it("brings a wright in at the gate rather than dropping them in the yard", () => {
    const world = garrison(1);
    const [wright] = world.wrights;
    expect(wright.y).toBe(YARD.bottom);
    expect(wright.moving).toBe(true);
  });

  it("removes one that has finished", () => {
    const world = garrison(3);
    dismiss(world, "w1");
    expect(world.wrights.map((wright) => wright.id)).toEqual(["w0", "w2"]);
  });

  it("ignores a dismissal for somebody who is not there", () => {
    const world = garrison(2);
    dismiss(world, "nobody");
    expect(world.wrights).toHaveLength(2);
  });
});

describe("walking about the yard", () => {
  it("never leaves the courtyard, however long it runs", () => {
    /*
     * The failure this guards against is a wright wandering out through a wall
     * and off across the meadow, which looks like a bug in the walls rather
     * than in the pathing and is exactly the sort of thing nobody sees until a
     * screenshot goes out.
     */
    const world = garrison(6);
    for (let step = 0; step < 4000; step += 1) {
      tickWorld(world);
      for (const wright of world.wrights) {
        expect(wright.x).toBeGreaterThanOrEqual(YARD.left - 0.01);
        expect(wright.x).toBeLessThanOrEqual(YARD.right + 0.01);
        expect(wright.y).toBeGreaterThanOrEqual(YARD.top - 0.01);
        expect(wright.y).toBeLessThanOrEqual(YARD.bottom + 0.01);
      }
    }
  });

  it("never stands on the hall, even walking from one side to the other", () => {
    /*
     * Choosing targets outside the building is not enough on its own: the walk
     * between two points on opposite sides goes straight across it, and a
     * wright strolling over the roof makes the whole map read as flat. This
     * asserts the stronger thing -- not one frame inside it, ever.
     */
    const world = garrison(6);
    const midX = (YARD.left + YARD.right) / 2;
    const midY = (YARD.top + YARD.bottom) / 2;

    for (let step = 0; step < 3000; step += 1) {
      tickWorld(world);
      for (const wright of world.wrights) {
        const inside =
          Math.abs(wright.x - midX) < 1.79 && Math.abs(wright.y - midY) < 1.79;
        expect(inside, `${wright.id} was on the hall at ${wright.x},${wright.y}`).toBe(false);
      }
    }
  });

  it("keeps moving rather than settling into a stack", () => {
    /*
     * A wander that always picked the same target would look like a crowd
     * frozen in one corner within a minute.
     */
    const world = garrison(5);
    run(world, 600);
    const places = new Set(
      world.wrights.map((wright) => `${Math.round(wright.x)}:${Math.round(wright.y)}`),
    );
    expect(places.size).toBeGreaterThan(1);
  });

  it("moves when ticked and stops dead when it is not", () => {
    /*
     * This is the whole of how pausing works: the route stops calling tick.
     * Both halves are asserted, because "nothing moved" on its own is also
     * what a world that never moves at all looks like.
     */
    const where = (world: World) => world.wrights.map((w) => `${w.x}:${w.y}`);
    const world = garrison(3);

    const atStart = where(world);
    run(world, 40);
    const afterTicks = where(world);
    expect(afterTicks).not.toEqual(atStart);

    const withoutTicks = where(world);
    expect(withoutTicks).toEqual(afterTicks);
  });

  it("gives the same world for the same run, every time", () => {
    /*
     * Deterministic on purpose: a field that differs on every reload cannot be
     * screenshotted in review and cannot be tested at all.
     */
    const a = garrison(4);
    const b = garrison(4);
    run(a, 500);
    run(b, 500);
    expect(a.wrights.map((w) => [w.x, w.y])).toEqual(b.wrights.map((w) => [w.x, w.y]));
  });

  it("faces the way it is walking", () => {
    const world = garrison(4);
    run(world, 120);
    for (const wright of world.wrights) {
      expect([1, -1]).toContain(wright.facing);
    }
  });
});

describe("fighting, and showing that it is fighting", () => {
  /** A yard with one fault already in it and one wright sent to deal with it. */
  function skirmish(kind: string): World {
    const world = createWorld(YARD);
    muster(world, { id: "w", name: "fix: a thing", kind, work: "bug" });
    world.foes.push({
      id: "f1",
      kind: "mite",
      x: (YARD.left + YARD.right) / 2,
      y: YARD.top,
      hp: 50,
      maxHp: 50,
      speed: 0,
      facing: 1,
      hurt: 0,
    });
    return world;
  }

  it("gets round the hall to a fault on the far side of it", () => {
    /*
     * The regression test for three separate attempts at this.
     *
     * A wright at the gate and a fault directly opposite, with the hall
     * between them, is the worst case for anything that steers by local rules:
     * shoving out of the wall makes it vibrate, sliding along the wall makes
     * it creep at a twentieth speed, and heading for the nearest corner walks
     * it into the wall and stops. All three look, on screen, like a hero
     * having a fit against a building.
     *
     * What is asserted is only that it arrives. How it gets there is allowed
     * to change.
     */
    const world = skirmish("openclaw");
    const foe = world.foes[0];
    let closest = Infinity;
    for (let step = 0; step < 400; step += 1) {
      tickWorld(world);
      const wright = world.wrights[0];
      closest = Math.min(closest, Math.hypot(foe.x - wright.x, foe.y - wright.y));
    }
    expect(closest).toBeLessThan(1);
  });

  it("swings, and holds the swing long enough to be seen", () => {
    /*
     * The failure this guards against: an action that is true only on the tick
     * the damage lands is one frame in eighteen, which is a swing nobody ever
     * sees on screen.
     */
    const world = skirmish("openclaw");
    let swinging = 0;
    for (let step = 0; step < 300; step += 1) {
      tickWorld(world);
      if (world.wrights[0].action === "attack") swinging += 1;
    }
    expect(swinging).toBeGreaterThan(20);
  });

  it("takes the fault down and counts it", () => {
    /*
     * The planted fault is gone; the field is not empty, because more keep
     * arriving for as long as somebody is working on one. Asserting an empty
     * field would be asserting that the waves stop, which is not the design.
     */
    const world = skirmish("openclaw");
    for (let step = 0; step < 2000; step += 1) tickWorld(world);
    expect(world.foes.some((foe) => foe.id === "f1")).toBe(false);
    expect(world.felled).toBeGreaterThan(0);
  });

  it("throws a bolt for the one class that fights at a distance", () => {
    const world = skirmish("codex");
    let sawBolt = false;
    for (let step = 0; step < 300; step += 1) {
      tickWorld(world);
      if (world.bolts.length > 0) sawBolt = true;
    }
    expect(sawBolt).toBe(true);
  });

  it("strikes in reach for everybody else, with no bolt", () => {
    const world = skirmish("openclaw");
    let sawBolt = false;
    let sawSpark = false;
    for (let step = 0; step < 300; step += 1) {
      tickWorld(world);
      if (world.bolts.length > 0) sawBolt = true;
      if (world.sparks.some((spark) => spark.kind === "hit")) sawSpark = true;
    }
    expect(sawBolt).toBe(false);
    expect(sawSpark).toBe(true);
  });

  it("clears its own effects rather than piling them up for ever", () => {
    /*
     * Every burst, bolt and number is short-lived. If any of them failed to be
     * removed, a keep left open all afternoon would slow to a crawl, and the
     * only symptom would be that it got gradually worse.
     */
    const world = skirmish("codex");
    for (let step = 0; step < 4000; step += 1) tickWorld(world);
    expect(world.bolts.length).toBeLessThan(20);
    expect(world.sparks.length).toBeLessThan(20);
    expect(world.marks.length).toBeLessThan(20);
  });
});

describe("building, and showing that it is building", () => {
  it("raises a structure through its stages and counts it", () => {
    const world = createWorld(YARD);
    muster(world, { id: "b", name: "feat: a thing", kind: "claude-code", work: "feature" });

    let hammering = 0;
    const stagesSeen = new Set<number>();
    for (let step = 0; step < 3000; step += 1) {
      tickWorld(world);
      if (world.wrights[0].action === "build") hammering += 1;
      for (const site of world.sites) {
        stagesSeen.add(Math.floor((site.progress / site.total) * 3));
      }
    }

    expect(hammering).toBeGreaterThan(20);
    /* It passed through more than one stage rather than jumping to finished. */
    expect(stagesSeen.size).toBeGreaterThan(1);
    expect(world.raised).toBeGreaterThan(0);
  });
});
