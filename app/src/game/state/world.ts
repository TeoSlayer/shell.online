import { TICK_MS } from "../engine/loop";

/**
 * What is on the field, and how it moves.
 *
 * The world is a plain object advanced by pure functions, with no reference to
 * a canvas, a sprite or the clock. Everything here can be run in a test by
 * calling `tickWorld` a few hundred times and looking at the result, which is
 * the only practical way to find out whether a wright can get stuck, whether a
 * wave ever ends, or whether two of them can stand in the same place.
 *
 * Positions are in tiles, as floats. Tiles rather than pixels because the map
 * is a grid and the interesting questions are about squares; floats because a
 * wright walking one tile per second should be somewhere sensible in between.
 */

/** What a session is doing, in the game's terms. */
export type Work = "bug" | "feature" | "idle";

export interface Wright {
  id: string;
  /** The session's name, shown on the plate under them. */
  name: string;
  /** The session kind, which is the class. See assets/heroes.ts. */
  kind: string;
  work: Work;
  x: number;
  y: number;
  /** Where they are heading. */
  toX: number;
  toY: number;
  /** Which way they are facing, for the sprite flip. */
  facing: 1 | -1;
  /** True while actually moving, so idle and walk can differ. */
  moving: boolean;
  /** Ticks to stand still before choosing somewhere new to be. */
  rest: number;
}

export interface World {
  wrights: Wright[];
  /** The courtyard they may walk in, in tiles. */
  bounds: { left: number; top: number; right: number; bottom: number };
  /** Advances once per tick; animations read it so a pause freezes them. */
  clock: number;
}

/** Tiles per second. Slow: this is a garrison at work, not a race. */
const SPEED = 1.6;
const STEP = SPEED / (1000 / TICK_MS);

/** How long a wright stands about before picking a new spot, in ticks. */
const REST_MIN = 30;
const REST_MAX = 150;

export function createWorld(bounds: World["bounds"]): World {
  return { wrights: [], bounds, clock: 0 };
}

/**
 * Deterministic enough to be repeatable, random enough not to look it.
 *
 * Math.random would make the world different every reload and impossible to
 * test; a hash of the wright and the clock gives a wander that is varied,
 * reproducible, and the same on every machine.
 */
function noise(seed: number): number {
  let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

/** Somewhere inside the courtyard, avoiding the block the keep stands on. */
function wander(world: World, wright: Wright, salt: number): { x: number; y: number } {
  const { left, top, right, bottom } = world.bounds;
  const width = right - left;
  const height = bottom - top;
  const seed = hashId(wright.id) + world.clock + salt;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const x = left + noise(seed + attempt * 31) * width;
    const y = top + noise(seed + attempt * 67) * height;
    if (!insideKeep(world, x, y)) return { x, y };
  }
  /* Give up and stand where they are rather than walking into a wall. */
  return { x: wright.x, y: wright.y };
}

/** Half the width of the block the hall stands on, in tiles. */
const KEEP_HALF = 1.8;

/** The hall occupies the middle of the yard; nobody walks through it. */
function insideKeep(world: World, x: number, y: number): boolean {
  const { left, top, right, bottom } = world.bounds;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  return Math.abs(x - midX) < KEEP_HALF && Math.abs(y - midY) < KEEP_HALF;
}

/**
 * Pushes a wright back out of the hall if a step took them into it.
 *
 * Choosing targets outside the building is not enough: the walk between two
 * points on opposite sides of it goes straight through, and a wright strolling
 * across the roof is the sort of thing that makes the whole map read as flat.
 *
 * Rather than pathfind, which is a great deal of machinery for one square
 * obstacle, a step that ends inside is moved out by the shortest way. What
 * that looks like on screen is somebody walking into the wall of the hall and
 * sliding along it until they can carry on, which is both what you want and
 * what a person does.
 */
function pushOutOfKeep(world: World, wright: Wright): void {
  if (!insideKeep(world, wright.x, wright.y)) return;
  const { left, top, right, bottom } = world.bounds;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;

  /* How far out each way, and leave by whichever is nearest. */
  const outLeft = midX - KEEP_HALF;
  const outRight = midX + KEEP_HALF;
  const outTop = midY - KEEP_HALF;
  const outBottom = midY + KEEP_HALF;
  const distances = [
    { value: wright.x - outLeft, apply: () => { wright.x = outLeft; } },
    { value: outRight - wright.x, apply: () => { wright.x = outRight; } },
    { value: wright.y - outTop, apply: () => { wright.y = outTop; } },
    { value: outBottom - wright.y, apply: () => { wright.y = outBottom; } },
  ];
  distances.sort((a, b) => a.value - b.value)[0].apply();
}

function hashId(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) {
    value = (Math.imul(value, 31) + id.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

/** Adds a wright at the gate, which is where somebody arriving would come in. */
export function muster(world: World, input: Omit<Wright, "x" | "y" | "toX" | "toY" | "facing" | "moving" | "rest">): Wright {
  const gateX = (world.bounds.left + world.bounds.right) / 2;
  const wright: Wright = {
    ...input,
    x: gateX,
    y: world.bounds.bottom,
    toX: gateX,
    toY: world.bounds.bottom,
    facing: 1,
    moving: false,
    rest: 0,
  };
  world.wrights.push(wright);
  /* Send them somewhere immediately, so they walk in rather than appearing. */
  const target = wander(world, wright, 7);
  wright.toX = target.x;
  wright.toY = target.y;
  wright.moving = true;
  return wright;
}

/** Removes a wright, for a session that has ended. */
export function dismiss(world: World, id: string): void {
  const at = world.wrights.findIndex((wright) => wright.id === id);
  if (at >= 0) world.wrights.splice(at, 1);
}

/**
 * One fixed step of the world.
 *
 * Mutates, deliberately: this runs thirty times a second over every actor on
 * the field, and rebuilding the array each time would make the garbage
 * collector the most expensive thing in the game.
 */
export function tickWorld(world: World): void {
  world.clock += 1;

  for (const wright of world.wrights) {
    if (!wright.moving) {
      wright.rest -= 1;
      if (wright.rest > 0) continue;
      const target = wander(world, wright, 13);
      wright.toX = target.x;
      wright.toY = target.y;
      wright.moving = true;
      continue;
    }

    const dx = wright.toX - wright.x;
    const dy = wright.toY - wright.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= STEP) {
      wright.x = wright.toX;
      wright.y = wright.toY;
      wright.moving = false;
      /* A spread of rests, so a garrison does not move in lockstep. */
      const roll = noise(hashId(wright.id) + world.clock);
      wright.rest = Math.round(REST_MIN + roll * (REST_MAX - REST_MIN));
      continue;
    }

    wright.x += (dx / distance) * STEP;
    wright.y += (dy / distance) * STEP;
    pushOutOfKeep(world, wright);
    /* Only turn on a real horizontal move, or they flip on the spot. */
    if (Math.abs(dx) > 0.05) wright.facing = dx > 0 ? 1 : -1;
  }
}

/**
 * A garrison to show when there are no live sessions.
 *
 * An empty keep is the correct picture of an account with nothing running, and
 * it is also a terrible first impression: the game would open on a walled yard
 * with nobody in it and no way to tell whether that was the point or a bug. So
 * the demo garrison stands in, and the interface says plainly that it is
 * standing in.
 */
export const DEMO_GARRISON: { id: string; name: string; kind: string; work: Work }[] = [
  { id: "demo-1", name: "fix: audit seal", kind: "claude-code", work: "bug" },
  { id: "demo-2", name: "feat: session board", kind: "codex", work: "feature" },
  { id: "demo-3", name: "chore: rotate keys", kind: "hermes", work: "idle" },
  { id: "demo-4", name: "fix: relay reconnect", kind: "openclaw", work: "bug" },
  { id: "demo-5", name: "npm run dev", kind: "terminal", work: "idle" },
];
