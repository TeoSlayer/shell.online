import { describe, expect, it } from "vitest";
import { MAX_CATCHUP_TICKS, TICK_MS, newAccumulator, pixelScale, ticksFor } from "./loop";

describe("keeping the simulation at a fixed rate", () => {
  it("runs one tick per tick's worth of time", () => {
    const { ticks } = ticksFor(newAccumulator(), TICK_MS);
    expect(ticks).toBe(1);
  });

  it("runs nothing for a frame shorter than a tick, and remembers the time", () => {
    const first = ticksFor(newAccumulator(), TICK_MS / 2);
    expect(first.ticks).toBe(0);
    /* The other half arrives next frame and the tick happens then. */
    expect(ticksFor(first.next, TICK_MS / 2).ticks).toBe(1);
  });

  it("runs the same number of ticks whatever the display rate", () => {
    /*
     * The point of the whole module: a second of wall clock is 30 ticks on a
     * 30Hz panel and on a 144Hz one, so the game is not slower on one and
     * faster on the other.
     */
    const run = (frameMs: number, frames: number) => {
      let accumulator = newAccumulator();
      let total = 0;
      for (let index = 0; index < frames; index += 1) {
        const result = ticksFor(accumulator, frameMs);
        total += result.ticks;
        accumulator = result.next;
      }
      return total;
    };
    /*
     * Within a tick of 30, not exactly 30: a 144Hz frame is 6.944ms, and 144
     * of those add up to a hair under a second in binary floating point. The
     * guarantee worth having is that the rates agree with each other, not that
     * they agree with arithmetic that cannot be done exactly.
     */
    for (const total of [run(1000 / 60, 60), run(1000 / 144, 144), run(1000 / 30, 30)]) {
      expect(total).toBeGreaterThanOrEqual(29);
      expect(total).toBeLessThanOrEqual(30);
    }
  });

  it("refuses to replay a battle nobody watched", () => {
    /* Ten minutes in a background tab is not ten minutes of simulation owed. */
    const { ticks } = ticksFor(newAccumulator(), 600_000);
    expect(ticks).toBe(MAX_CATCHUP_TICKS);
  });

  it("drops the time it did not run, rather than spiralling", () => {
    /*
     * Carrying the unrun debt forward would mean a game that fell behind could
     * never catch up: every frame would ask for more than the last.
     */
    let { next } = ticksFor(newAccumulator(), 600_000);
    expect(next.debt).toBeLessThan(TICK_MS * (MAX_CATCHUP_TICKS + 1));
    ({ next } = ticksFor(next, TICK_MS));
    expect(next.debt).toBeLessThan(TICK_MS * (MAX_CATCHUP_TICKS + 1));
  });

  it("ignores a clock that moved backwards", () => {
    /* A suspended laptop or a stepped system clock. */
    expect(ticksFor(newAccumulator(), -500).ticks).toBe(0);
    expect(ticksFor(newAccumulator(), Number.NaN).ticks).toBe(0);
    expect(ticksFor(newAccumulator(), Number.POSITIVE_INFINITY).ticks).toBe(0);
  });
});

describe("choosing how big to draw the pixels", () => {
  it("picks whole numbers only", () => {
    /*
     * 2.37x would make some pixels two screen pixels wide and some three, and
     * the unevenness reads as blur however good the art is.
     */
    const scale = pixelScale(1000, 800, 320, 180);
    expect(Number.isInteger(scale)).toBe(true);
  });

  it("fills as much of the viewport as a whole number allows", () => {
    expect(pixelScale(640, 360, 320, 180)).toBe(2);
    expect(pixelScale(1280, 720, 320, 180)).toBe(4);
  });

  it("fits the tighter of the two dimensions", () => {
    /* A wide, short window is bounded by its height. */
    expect(pixelScale(3000, 400, 320, 180)).toBe(2);
  });

  it("never disappears on a small window", () => {
    expect(pixelScale(100, 60, 320, 180)).toBe(1);
    expect(pixelScale(0, 0, 320, 180)).toBe(1);
  });

  it("stops growing, so a 4K display is not all thumbs", () => {
    expect(pixelScale(7680, 4320, 320, 180, 6)).toBe(6);
  });

  it("survives a design size of nothing", () => {
    expect(pixelScale(1920, 1080, 0, 0)).toBe(1);
  });
});
