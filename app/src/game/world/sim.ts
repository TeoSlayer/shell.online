import { GARRISONS, garrisonFor, type Garrison } from "./marches";
import type { Work } from "./work";

/**
 * Who is on the Marches, and what they are doing.
 *
 * A rewrite of the old yard simulation, and much simpler for one reason: the
 * map is open country. The old one spent most of its code steering around the
 * one building in the middle of the one yard, and every version of that
 * steering shook — the wright re-decided which way to go thirty times a second
 * and spent its time turning round rather than walking.
 *
 * Here there is nowhere that has to be gone around. A wright walks to the
 * garrison its work belongs to and mills about inside it; the buildings sit in
 * the middle and everybody else keeps to the apron. No avoidance, no corner
 * routing, no oscillation. The fix for the shaking was mostly deleting the
 * thing that shook.
 *
 * Everything here is a plain object advanced by pure functions, with no Pixi in
 * it, so a thousand ticks can be run in a test and looked at.
 */

/* Defined in world/work.ts, which the service shares; re-exported for ease. */
export type { Work };
export type Side = "garrison" | "unmade";

export interface Actor {
  id: string;
  side: Side;
  /** For a wright, the session kind. For the rest, which sprite to draw. */
  kind: string;
  /** Shown on the plate, and in the panel when clicked. */
  name: string;
  work: Work;
  x: number;
  y: number;
  toX: number;
  toY: number;
  facing: 1 | -1;
  moving: boolean;
  hp: number;
  maxHp: number;
  /** Ticks of flinch left, so a hit is visible as well as counted. */
  hurt: number;
  /** What the renderer draws: standing, walking, or mid-blow. */
  action: "stand" | "walk" | "attack";
  actionUntil: number;
  /** Ticks to mill about before choosing somewhere new inside the garrison. */
  rest: number;
  /** Which holding this actor belongs to. */
  home: string;
  /** Who it is fighting, held until that one dies or wanders off. */
  targetId?: string;
  /**
   * A real session, rather than one of the garrison's own soldiers.
   *
   * Only these are worth clicking: they stand for something in the account.
   * The rest are there so a battle looks like a battle.
   */
  session?: { id: string; startedAt: number; host: string; command: string };
}

export interface Effect {
  id: number;
  kind: "hit" | "cast" | "build" | "fell";
  x: number;
  y: number;
  life: number;
  maxLife: number;
}

export interface Mark {
  id: number;
  text: string;
  x: number;
  y: number;
  life: number;
  maxLife: number;
  kind: "damage" | "gain";
}

export interface Sim {
  actors: Actor[];
  effects: Effect[];
  marks: Mark[];
  clock: number;
  spawned: number;
  felled: number;
  raised: number;
  /** Ticks until the next of the Unmade arrives. */
  nextSpawn: number;
}

/** Tiles a second. */
const WALK = 1.9;
const CHARGE = 2.4;
/** Thirty ticks a second, matching the renderer's fixed step. */
const PER_TICK = 1 / 30;

const REACH = 0.9;
const CAST_REACH = 3.2;
const SWING_EVERY = 20;
const SWING_ANIM = 12;
const HURT_TICKS = 6;
const MARK_TICKS = 45;
const EFFECT_TICKS = 18;
const SPAWN_EVERY = 90;
const MAX_UNMADE = 14;
/** Beyond this a fight is abandoned and another chosen. */
const ABANDON_AT = 9;

export function createSim(): Sim {
  return {
    actors: [],
    effects: [],
    marks: [],
    clock: 0,
    spawned: 0,
    felled: 0,
    raised: 0,
    nextSpawn: 40,
  };
}

/** Deterministic, so the map is the same every time it is opened. */
function noise(seed: number): number {
  let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

function hashId(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) {
    value = (Math.imul(value, 31) + id.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

/**
 * Somewhere to stand inside a holding.
 *
 * On the apron, not the middle: the middle is where the buildings are, and a
 * soldier standing inside a church looks like a bug even when it is only a
 * missing collision.
 */
function spotIn(garrison: Garrison, seed: number): { x: number; y: number } {
  const angle = noise(seed) * Math.PI * 2;
  const distance = garrison.radius * (0.55 + noise(seed * 7) * 0.4);
  return {
    x: garrison.x + Math.cos(angle) * distance,
    y: garrison.y + Math.sin(angle) * distance * 0.85,
  };
}

let nextEffect = 1;

function addEffect(sim: Sim, kind: Effect["kind"], x: number, y: number): void {
  sim.effects.push({ id: nextEffect++, kind, x, y, life: EFFECT_TICKS, maxLife: EFFECT_TICKS });
}

function addMark(sim: Sim, text: string, x: number, y: number, kind: Mark["kind"]): void {
  sim.marks.push({ id: nextEffect++, text, x, y, life: MARK_TICKS, maxLife: MARK_TICKS, kind });
}

/** Adds a wright for a real session, at the garrison its work belongs to. */
export function muster(
  sim: Sim,
  input: { id: string; name: string; kind: string; work: Work; session?: Actor["session"] },
): Actor {
  /*
   * Mustering the same id twice returns the one already on the field.
   *
   * A Sim outlives the scene drawn from it -- React remounts an effect in
   * development, the roster poll returns the same session again -- and without
   * this each of those puts a second copy of the same wright on the map,
   * standing in the same spot, fighting the same foe twice.
   */
  const standing = sim.actors.find((actor) => actor.id === input.id);
  if (standing) return standing;

  const garrison = garrisonFor(input.work);
  const spot = spotIn(garrison, hashId(input.id));
  const actor: Actor = {
    ...input,
    side: "garrison",
    x: spot.x,
    y: spot.y + 4,
    toX: spot.x,
    toY: spot.y,
    facing: 1,
    moving: true,
    hp: 20,
    maxHp: 20,
    hurt: 0,
    action: "walk",
    actionUntil: 0,
    rest: 0,
    home: garrison.id,
  };
  sim.actors.push(actor);
  return actor;
}

/**
 * The garrison's own soldiers.
 *
 * They are not sessions and they never will be. They are here because a keep
 * with five people in it does not look like a keep, and a fault met by one
 * wright does not look like a battle. Clicking one says as much rather than
 * pretending it stands for something.
 */
export function garrisonSoldiers(sim: Sim): void {
  for (const garrison of GARRISONS) {
    const count = garrison.draws === "bug" ? 6 : 3;
    for (let index = 0; index < count; index += 1) {
      const id = `${garrison.id}-soldier-${index}`;
      /* Same reason as `muster`: calling this twice must not double the watch. */
      if (sim.actors.some((actor) => actor.id === id)) continue;
      const spot = spotIn(garrison, hashId(id));
      sim.actors.push({
        id,
        side: "garrison",
        kind: "soldier",
        name: `${garrison.name} watch`,
        work: garrison.draws === "bug" ? "bug" : "idle",
        x: spot.x,
        y: spot.y,
        toX: spot.x,
        toY: spot.y,
        facing: 1,
        moving: false,
        hp: 14,
        maxHp: 14,
        hurt: 0,
        action: "stand",
        actionUntil: 0,
        rest: Math.round(noise(hashId(id)) * 60),
        home: garrison.id,
      });
    }
  }
}

/**
 * Whether a real session is working on a fault, which is what draws the Unmade.
 *
 * Only sessions count. The garrison's own watch is drawn standing at a
 * bug-facing holding and would otherwise make this permanently true, so the
 * Unmade arrived on a map where nothing at all was broken -- which would make
 * the battle scenery rather than a read-out of the account. A quiet map is the
 * correct picture of a quiet day, and it is the reason a loud one means
 * something.
 */
function underAttack(sim: Sim): boolean {
  return sim.actors.some(
    (actor) => actor.side === "garrison" && actor.work === "bug" && actor.session !== undefined,
  );
}

const UNMADE_KINDS = [
  { kind: "mite", hp: 6, speed: 1.0 },
  { kind: "crawler", hp: 12, speed: 0.85 },
  { kind: "heisenbug", hp: 20, speed: 0.7 },
];

function spawnUnmade(sim: Sim): void {
  sim.spawned += 1;
  const watch = GARRISONS.find((garrison) => garrison.draws === "bug") ?? GARRISONS[0];
  const roll = noise(sim.spawned * 977);
  const choice = UNMADE_KINDS[Math.min(2, Math.floor(roll * UNMADE_KINDS.length))];

  /* Out of the open country north-east of the Watch, never through a gate. */
  const angle = -Math.PI / 4 + (noise(sim.spawned * 31) - 0.5) * 1.4;
  const distance = watch.radius + 5 + noise(sim.spawned * 53) * 5;
  sim.actors.push({
    id: `unmade-${sim.spawned}`,
    side: "unmade",
    kind: choice.kind,
    name: choice.kind,
    work: "bug",
    x: watch.x + Math.cos(angle) * distance,
    y: watch.y + Math.sin(angle) * distance,
    toX: watch.x,
    toY: watch.y,
    facing: -1,
    moving: true,
    hp: choice.hp,
    maxHp: choice.hp,
    hurt: 0,
    action: "walk",
    actionUntil: 0,
    rest: 0,
    home: watch.id,
  });
}

function blow(kind: string): number {
  switch (kind) {
    case "codex":
      return 4;
    case "openclaw":
      return 3;
    case "soldier":
      return 2;
    case "hermes":
      return 2;
    default:
      return 3;
  }
}

function ranged(kind: string): boolean {
  return kind === "codex";
}

/** The nearest enemy, held once chosen. This is what stops the shaking. */
function chooseEnemy(sim: Sim, actor: Actor): Actor | undefined {
  const held = sim.actors.find((other) => other.id === actor.targetId);
  if (held && held.hp > 0 && Math.hypot(held.x - actor.x, held.y - actor.y) < ABANDON_AT) {
    return held;
  }

  let best: Actor | undefined;
  let bestDistance = Infinity;
  for (const other of sim.actors) {
    if (other.side === actor.side || other.hp <= 0) continue;
    const distance = Math.hypot(other.x - actor.x, other.y - actor.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = other;
    }
  }
  actor.targetId = best?.id;
  return best;
}

/** A step towards a point. No avoidance: the map is open country. */
function stepTo(actor: Actor, toX: number, toY: number, speed: number): boolean {
  const step = speed * PER_TICK;
  const dx = toX - actor.x;
  const dy = toY - actor.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= step) {
    actor.x = toX;
    actor.y = toY;
    return false;
  }
  actor.x += (dx / distance) * step;
  actor.y += (dy / distance) * step;
  /* Face the way travelled, with a deadband so a stopped actor does not spin. */
  if (Math.abs(dx) > 0.02) actor.facing = dx > 0 ? 1 : -1;
  return true;
}

export function tickSim(sim: Sim): void {
  sim.clock += 1;

  if (underAttack(sim) && sim.actors.filter((a) => a.side === "unmade").length < MAX_UNMADE) {
    sim.nextSpawn -= 1;
    if (sim.nextSpawn <= 0) {
      sim.nextSpawn = SPAWN_EVERY;
      spawnUnmade(sim);
    }
  }

  for (const effect of sim.effects) effect.life -= 1;
  sim.effects = sim.effects.filter((effect) => effect.life > 0);
  for (const mark of sim.marks) mark.life -= 1;
  sim.marks = sim.marks.filter((mark) => mark.life > 0);

  for (const actor of sim.actors) {
    if (actor.hurt > 0) actor.hurt -= 1;
    if (actor.action !== "stand" && sim.clock >= actor.actionUntil) {
      actor.action = actor.moving ? "walk" : "stand";
    }

    /* Anyone who fights looks for someone to fight. */
    const fights = actor.side === "unmade" || actor.work === "bug";
    if (fights) {
      const enemy = chooseEnemy(sim, actor);
      if (enemy) {
        const dx = enemy.x - actor.x;
        const distance = Math.hypot(dx, enemy.y - actor.y);
        const reach = ranged(actor.kind) ? CAST_REACH : REACH;

        if (distance > reach) {
          actor.moving = stepTo(actor, enemy.x, enemy.y, CHARGE);
          if (actor.action !== "attack") actor.action = "walk";
        } else {
          actor.moving = false;
          if (Math.abs(dx) > 0.02) actor.facing = dx > 0 ? 1 : -1;
          if ((sim.clock + hashId(actor.id)) % SWING_EVERY === 0) {
            const damage = blow(actor.kind);
            actor.action = "attack";
            actor.actionUntil = sim.clock + SWING_ANIM;
            addEffect(sim, ranged(actor.kind) ? "cast" : "hit", enemy.x, enemy.y);
            enemy.hp -= damage;
            enemy.hurt = HURT_TICKS;
            addMark(sim, String(damage), enemy.x, enemy.y, "damage");
            if (enemy.hp <= 0) {
              addEffect(sim, "fell", enemy.x, enemy.y);
              if (enemy.side === "unmade") sim.felled += 1;
            }
          }
        }
        continue;
      }
    }

    /* Nobody to fight: mill about inside the holding. */
    if (!actor.moving) {
      actor.rest -= 1;
      if (actor.rest > 0) continue;
      const garrison = GARRISONS.find((g) => g.id === actor.home) ?? GARRISONS[0];
      const spot = spotIn(garrison, hashId(actor.id) + sim.clock);
      actor.toX = spot.x;
      actor.toY = spot.y;
      actor.moving = true;
      actor.action = "walk";
      continue;
    }

    if (!stepTo(actor, actor.toX, actor.toY, WALK)) {
      actor.moving = false;
      actor.action = "stand";
      actor.rest = Math.round(20 + noise(hashId(actor.id) + sim.clock) * 70);
    }
  }

  /*
   * The dead are taken off after everybody has had their turn, so an actor
   * removed mid-loop cannot leave somebody else holding a reference to it.
   */
  const fallen = sim.actors.filter((actor) => actor.hp <= 0);
  if (fallen.length > 0) {
    const gone = new Set(fallen.map((actor) => actor.id));
    sim.actors = sim.actors.filter((actor) => !gone.has(actor.id));
    for (const actor of sim.actors) {
      if (actor.targetId && gone.has(actor.targetId)) actor.targetId = undefined;
    }
    /*
     * A garrison soldier who falls is back on watch shortly. They are scenery,
     * and scenery that thins out over an afternoon leaves an empty map.
     */
    for (const dead of fallen) {
      if (dead.side === "garrison" && dead.kind === "soldier") {
        const garrison = GARRISONS.find((g) => g.id === dead.home) ?? GARRISONS[0];
        const spot = spotIn(garrison, hashId(dead.id) + sim.clock);
        sim.actors.push({
          ...dead,
          x: spot.x,
          y: spot.y,
          toX: spot.x,
          toY: spot.y,
          hp: dead.maxHp,
          hurt: 0,
          action: "stand",
          moving: false,
          targetId: undefined,
          rest: 90,
        });
      }
    }
  }
}
