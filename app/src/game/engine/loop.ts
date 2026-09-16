/**
 * A fixed simulation step, drawn at whatever rate the display runs.
 *
 * Simulating in step with the monitor sounds simpler and is a trap: the same
 * game then runs at half speed on a 30Hz panel and double on a 120Hz one, and
 * a tab that was in the background comes back with one enormous frame that
 * teleports everything. So the simulation advances in fixed ticks and the
 * renderer draws whatever the latest tick produced.
 */

/** 30 ticks a second. Plenty for marching, swinging and building. */
export const TICK_MS = 1000 / 30;

/**
 * The most simulation one frame may run.
 *
 * Without a ceiling, a tab restored after ten minutes asks for eighteen
 * thousand ticks in a single frame, which locks the page up solid while it
 * catches up on a battle nobody watched. Time is dropped instead: the world
 * resumes where it is rather than replaying where it was.
 */
export const MAX_CATCHUP_TICKS = 5;

export interface Accumulator {
  /** Simulation time owed but not yet run. */
  debt: number;
}

export function newAccumulator(): Accumulator {
  return { debt: 0 };
}

/**
 * How many ticks to run for a frame of `deltaMs`, and what is left over.
 *
 * Pure, and returns the new accumulator rather than mutating it, so the
 * catch-up rules can be tested without a browser or a clock.
 */
export function ticksFor(
  accumulator: Accumulator,
  deltaMs: number,
): { ticks: number; next: Accumulator } {
  /*
   * A negative or absurd delta means the clock moved oddly -- a suspended
   * laptop, a stepped clock, a test passing something silly. Nothing good
   * comes of simulating it.
   */
  const delta = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
  const debt = accumulator.debt + delta;
  const wanted = Math.floor(debt / TICK_MS);
  const ticks = Math.min(wanted, MAX_CATCHUP_TICKS);
  /*
   * Every whole tick is paid off, including the ones refused above. Only the
   * part-tick remainder is carried.
   *
   * Paying off just the ticks that ran instead is the spiral: a tab restored
   * after ten minutes would keep ten minutes of debt, run its five ticks, and
   * arrive at the next frame still owing ten minutes -- for ever. The time
   * that was not simulated is gone, and the world resumes where it is rather
   * than replaying where it was.
   */
  return { ticks, next: { debt: debt - wanted * TICK_MS } };
}

export interface LoopHandlers {
  /** Advance the world by exactly one TICK_MS. */
  tick: (tickIndex: number) => void;
  /**
   * Draw. `blend` is how far between the last tick and the next this frame
   * falls, 0 to 1, for smoothing positions between them.
   */
  draw: (blend: number) => void;
}

/**
 * Runs the loop until stopped.
 *
 * Nothing runs while the document is hidden. A game loop in a background tab
 * burns a laptop's battery to animate pixels nobody is looking at, and the
 * browser will throttle it into exactly the enormous-delta problem the
 * accumulator's ceiling exists to survive.
 */
export function startLoop(handlers: LoopHandlers): () => void {
  let frame = 0;
  let last = performance.now();
  let accumulator = newAccumulator();
  let tickIndex = 0;
  let stopped = false;

  const onVisibility = () => {
    /*
     * Coming back, time starts again from now. The wall-clock gap while the
     * tab was hidden is not simulation anybody is owed.
     */
    if (!document.hidden) last = performance.now();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const frameStep = (now: number) => {
    if (stopped) return;
    frame = requestAnimationFrame(frameStep);
    if (document.hidden) {
      last = now;
      return;
    }

    const { ticks, next } = ticksFor(accumulator, now - last);
    accumulator = next;
    last = now;

    for (let index = 0; index < ticks; index += 1) {
      tickIndex += 1;
      handlers.tick(tickIndex);
    }
    handlers.draw(Math.min(1, accumulator.debt / TICK_MS));
  };

  frame = requestAnimationFrame(frameStep);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * The integer factor to draw pixel art at, for a given viewport.
 *
 * Integer, always. A sprite drawn at 2.37x has some pixels two screen pixels
 * wide and some three, and the eye reads that unevenness as a blurry mistake
 * however carefully the art was made. Better a slightly smaller picture that
 * is crisp.
 *
 * At least 1, so a very small window still gets something rather than nothing.
 */
export function pixelScale(
  viewportWidth: number,
  viewportHeight: number,
  designWidth: number,
  designHeight: number,
  max = 6,
): number {
  if (designWidth <= 0 || designHeight <= 0) return 1;
  const fit = Math.min(viewportWidth / designWidth, viewportHeight / designHeight);
  return Math.max(1, Math.min(max, Math.floor(fit)));
}
