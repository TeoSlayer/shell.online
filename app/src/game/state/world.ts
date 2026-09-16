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

/** One of the Unmade, on its way in. */
export interface Foe {
  id: string;
  kind: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  facing: 1 | -1;
  /** Ticks of flinch left, so a hit is visible as well as counted. */
  hurt: number;
}

/** A number floating up off something that was just hit. */
export interface Mark {
  id: number;
  text: string;
  x: number;
  y: number;
  /** Counts down; the renderer uses it for the rise and the fade. */
  life: number;
  maxLife: number;
  kind: "damage" | "gain";
}

/** Something being raised in the yard, by whoever is building a feature. */
export interface Site {
  id: string;
  x: number;
  y: number;
  /** 0 to `total`; the stage drawn is derived from it. */
  progress: number;
  total: number;
}

export interface World {
  wrights: Wright[];
  foes: Foe[];
  sites: Site[];
  marks: Mark[];
  /** The courtyard they may walk in, in tiles. */
  bounds: { left: number; top: number; right: number; bottom: number };
  /** Advances once per tick; animations read it so a pause freezes them. */
  clock: number;
  /** Ticks until the next of the Unmade wanders in. */
  nextSpawn: number;
  /** Counts up, for ids that do not repeat. */
  spawned: number;
  /** Faults put down since the keep was opened. Feeds the stats. */
  felled: number;
  /** Structures finished since the keep was opened. */
  raised: number;
}

/** Tiles per second. Slow: this is a garrison at work, not a race. */
const SPEED = 1.6;
const STEP = SPEED / (1000 / TICK_MS);

/** How long a wright stands about before picking a new spot, in ticks. */
const REST_MIN = 30;
const REST_MAX = 150;

export function createWorld(bounds: World["bounds"]): World {
  return {
    wrights: [],
    foes: [],
    sites: [],
    marks: [],
    bounds,
    clock: 0,
    nextSpawn: SPAWN_EVERY,
    spawned: 0,
    felled: 0,
    raised: 0,
  };
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

/* ---- the Unmade --------------------------------------------------------- */

/** Ticks between arrivals, while anybody is working on a fault. */
const SPAWN_EVERY = 150;
/** More than this on the field at once is a crowd nobody can read. */
const MAX_FOES = 6;
/** How close a wright has to be to swing, in tiles. */
const REACH = 0.9;
/** Ticks between blows. */
const SWING_EVERY = 18;
/** How long a hit shows, and how long a number floats. */
const HURT_TICKS = 6;
const MARK_TICKS = 40;

const FOE_KINDS = [
  { kind: "mite", hp: 3, speed: 1.1 },
  { kind: "crawler", hp: 6, speed: 0.8 },
  { kind: "heisenbug", hp: 9, speed: 0.6 },
];

/**
 * Whether anything should be coming in at all.
 *
 * The Unmade arrive because somebody is fixing a fault, not on a timer of
 * their own. A keep with nothing broken in it is a quiet keep, and that is the
 * correct picture of an account whose sessions are all building.
 */
function underAttack(world: World): boolean {
  return world.wrights.some((wright) => wright.work === "bug");
}

function spawnFoe(world: World): void {
  const { left, top, right, bottom } = world.bounds;
  world.spawned += 1;
  const roll = noise(world.spawned * 977 + world.clock);
  const choice = FOE_KINDS[Math.min(FOE_KINDS.length - 1, Math.floor(roll * FOE_KINDS.length))];

  /*
   * In over a wall rather than through the gate. The gate is the way the
   * garrison comes and goes; things that are not supposed to be here should
   * not be using the door.
   */
  const side = Math.floor(noise(world.spawned * 31) * 4);
  const along = noise(world.spawned * 53);
  const x = side === 0 ? left : side === 1 ? right : left + along * (right - left);
  const y = side === 2 ? top : side === 3 ? bottom : top + along * (bottom - top);

  world.foes.push({
    id: `foe-${world.spawned}`,
    kind: choice.kind,
    x,
    y,
    hp: choice.hp,
    maxHp: choice.hp,
    speed: choice.speed,
    facing: 1,
    hurt: 0,
  });
}

function addMark(world: World, text: string, x: number, y: number, kind: Mark["kind"]): void {
  world.marks.push({
    id: world.clock * 1000 + world.marks.length,
    text,
    x,
    y,
    life: MARK_TICKS,
    maxLife: MARK_TICKS,
    kind,
  });
}

/** Ticks between hammer blows. Slower than a sword; a wall takes a while. */
const HAMMER_EVERY = 24;
/** How many blows a structure takes, over the three stages. */
const BUILD_EFFORT = 18;

/**
 * The plot a wright is working on, claimed on first need.
 *
 * One site per builder rather than one shared site, because two sessions
 * building different features are doing two different things and the field
 * should say so. The plot is picked from the wright's own id, so the same
 * session always returns to the same corner of the yard.
 */
function siteFor(world: World, wright: Wright): Site {
  const existing = world.sites.find((site) => site.id === wright.id);
  if (existing) return existing;

  const { left, top, right, bottom } = world.bounds;
  const seed = hashId(wright.id);
  let x = left + noise(seed) * (right - left);
  let y = top + noise(seed * 3) * (bottom - top);
  /* Not on the hall, and not so close to it that the two overlap. */
  for (let attempt = 0; attempt < 8 && insideKeep(world, x, y); attempt += 1) {
    x = left + noise(seed + attempt * 41) * (right - left);
    y = top + noise(seed * 3 + attempt * 59) * (bottom - top);
  }

  const site: Site = { id: wright.id, x, y, progress: 0, total: BUILD_EFFORT };
  world.sites.push(site);
  return site;
}

/** The nearest fault to a wright, or nothing when the field is clear. */
function nearestFoe(world: World, wright: Wright): Foe | undefined {
  let best: Foe | undefined;
  let bestDistance = Infinity;
  for (const foe of world.foes) {
    const distance = Math.hypot(foe.x - wright.x, foe.y - wright.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = foe;
    }
  }
  return best;
}

/**
 * How hard a class hits.
 *
 * The differences are small and are there to make the classes legible on the
 * field, not to make one of them correct to pick. Nobody chooses which session
 * kind they are running to win a fight in a browser game, and a balance patch
 * for something nobody chooses would be a strange thing to write.
 */
function blow(kind: string): number {
  switch (kind) {
    case "codex":
      return 3;
    case "openclaw":
      return 2;
    case "hermes":
      return 1;
    default:
      return 2;
  }
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

  /* Arrivals, while there is a fault being worked on. */
  if (underAttack(world) && world.foes.length < MAX_FOES) {
    world.nextSpawn -= 1;
    if (world.nextSpawn <= 0) {
      world.nextSpawn = SPAWN_EVERY;
      spawnFoe(world);
    }
  }

  /* The Unmade make for the hall. */
  const midX = (world.bounds.left + world.bounds.right) / 2;
  const midY = (world.bounds.top + world.bounds.bottom) / 2;
  for (const foe of world.foes) {
    if (foe.hurt > 0) foe.hurt -= 1;
    const dx = midX - foe.x;
    const dy = midY - foe.y;
    const distance = Math.hypot(dx, dy);
    /*
     * They stop at the hall rather than entering it, and nothing happens when
     * they arrive. There is no losing here on purpose: the game is a picture of
     * work that has already happened, and a keep that falls over because
     * somebody closed their laptop would be a punishment for nothing.
     */
    if (distance > KEEP_HALF + 0.4) {
      const step = foe.speed / (1000 / TICK_MS);
      foe.x += (dx / distance) * step;
      foe.y += (dy / distance) * step;
      if (Math.abs(dx) > 0.05) foe.facing = dx > 0 ? 1 : -1;
    }
  }

  /* Numbers rise and fade. */
  for (const mark of world.marks) mark.life -= 1;
  world.marks = world.marks.filter((mark) => mark.life > 0);

  for (const wright of world.wrights) {
    /*
     * A wright working a fault goes to the nearest one and swings at it.
     * Everybody else wanders, which is what the yard looks like when the
     * sessions running are building things rather than fixing them.
     */
    /*
     * A wright building a feature claims a plot in the yard and works on it
     * until it is standing. The stages are what make it worth watching; a
     * structure that appeared finished in one step would be a number going up
     * with a picture next to it.
     */
    if (wright.work === "feature") {
      const site = siteFor(world, wright);
      const dx = site.x - wright.x;
      const dy = site.y - wright.y;
      const distance = Math.hypot(dx, dy);

      if (distance > REACH) {
        const step = SPEED / (1000 / TICK_MS);
        wright.x += (dx / distance) * step;
        wright.y += (dy / distance) * step;
        pushOutOfKeep(world, wright);
        wright.moving = true;
        if (Math.abs(dx) > 0.05) wright.facing = dx > 0 ? 1 : -1;
      } else {
        wright.moving = false;
        if (Math.abs(dx) > 0.05) wright.facing = dx > 0 ? 1 : -1;
        if ((world.clock + hashId(wright.id)) % HAMMER_EVERY === 0) {
          site.progress += 1;
          if (site.progress >= site.total) {
            world.raised += 1;
            addMark(world, "RAISED", site.x, site.y, "gain");
            world.sites = world.sites.filter((other) => other.id !== site.id);
          }
        }
      }
      continue;
    }

    if (wright.work === "bug") {
      const foe = nearestFoe(world, wright);
      if (foe) {
        const dx = foe.x - wright.x;
        const dy = foe.y - wright.y;
        const distance = Math.hypot(dx, dy);

        if (distance > REACH) {
          const step = SPEED / (1000 / TICK_MS);
          wright.x += (dx / distance) * step;
          wright.y += (dy / distance) * step;
          pushOutOfKeep(world, wright);
          wright.moving = true;
          if (Math.abs(dx) > 0.05) wright.facing = dx > 0 ? 1 : -1;
        } else {
          wright.moving = false;
          if (Math.abs(dx) > 0.05) wright.facing = dx > 0 ? 1 : -1;
          /*
           * Staggered by who is swinging, so two wrights on one fault do not
           * land every blow on the same tick and read as one attacker.
           */
          if ((world.clock + hashId(wright.id)) % SWING_EVERY === 0) {
            const damage = blow(wright.kind);
            foe.hp -= damage;
            foe.hurt = HURT_TICKS;
            addMark(world, String(damage), foe.x, foe.y, "damage");
            if (foe.hp <= 0) {
              world.felled += 1;
              world.foes = world.foes.filter((other) => other.id !== foe.id);
            }
          }
        }
        continue;
      }
      /* Nothing to fight; fall through and wander like everyone else. */
    }

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
