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
