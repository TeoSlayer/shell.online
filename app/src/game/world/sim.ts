import { GARRISONS, type Garrison } from "./marches";
import { assignCamps, CAMP_RADIUS, type Camp } from "./camps";
import { assignBanners } from "./banners";
import type { Work } from "./work";
import { pushOut } from "./solids";

/**
 * Who is on the Marches, and what they are doing.
 *
 * The shape of it: **a hero is a person, a soldier is a session, and a soldier
 * belongs to the hero who owns it.** Somebody with ten Claude Code sessions and
 * three OpenClaw sessions has thirteen soldiers of two classes, all of them
 * theirs, all of them around their camp. That is the whole model, and every
 * rule below follows from it.
 *
 * Heroes exist whether or not anything is running. That matters: a team member
 * with nothing open is still on the team, so they are still somewhere on the
 * map. It is the soldiers around them that come and go.
 *
 * There is no obstacle avoidance and there never will be. The map is open
 * country, and the version that had some spent most of its code steering round
 * the one building in the one yard -- every version of which shook, because a
 * wright that cannot reach where it is going re-decides thirty times a second
 * and spends its life turning round. The fix was deleting the thing that shook.
 *
 * Everything here is plain objects advanced by pure functions, with no Pixi in
 * it, so a thousand ticks can be run in a test and looked at.
 */

export type { Work };
export type Side = "garrison" | "unmade";

/**
 * What an actor is, which decides how it moves.
 *
 * `hero` and `soldier` stand for something in the account. `watch` is scenery:
 * a keep with five people in it does not look like a keep, and a fault met by
 * one wright does not look like a battle. `unmade` is the fault itself.
 *
 * `fallen` is a soldier whose session has closed, walking to the Barrow. It is
 * a role rather than an immediate removal because a session ending is the most
 * important thing that happens in this game -- it is where the experience comes
 * from -- and a figure that blinks out of existence is the one way of showing
 * that which says nothing at all.
 */
export type Role = "hero" | "soldier" | "watch" | "unmade" | "fallen";

export interface Actor {
  id: string;
  side: Side;
  role: Role;
  /** For a soldier, the session kind. For the rest, which sprite to draw. */
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
  /** Ticks to mill about before choosing somewhere new. */
  rest: number;
  /** Which holding this actor belongs to, for the watch. */
  home: string;
  /**
   * Whose this is.
   *
   * A hero's own account id, or for a soldier the id of the hero who owns it.
   * This is the join the whole model turns on: it is what puts a session's
   * soldier beside the right person.
   */
  heroUid?: string;
  /**
   * A hero walking where the player pointed.
   *
   * Only ever true of the player's own hero. Cleared on arrival, and it is what
   * makes an order outrank milling about.
   */
  ordered?: boolean;
  /**
   * Where a hero has been told to hold.
   *
   * Set when an order finishes, and it becomes the ground they mill about and
   * the ground their retinue gathers on. Without it a hero walked to where they
   * were sent, arrived, noticed they were a long way from their camp, and
   * immediately walked back -- which makes the one thing the player can do in
   * this game pointless.
   */
  station?: { x: number; y: number };
  /** Who it is fighting, held until that one dies or wanders off. */
  targetId?: string;
  /**
   * A real session, rather than a hero or one of the watch.
   *
   * Only these stand for something running. The rest are a person, or scenery.
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
  /** How many sessions have closed while this field has been watched. */
  finished: number;
  /** Where each hero holds, by account id. */
  camps: Map<string, Camp>;
  /**
   * What colour each hero's company is washed in.
   *
   * Kept here rather than worked out in the renderer because it has to be the
   * same everywhere it is used -- the ring on the ground, the plate, and the
   * inspect card -- and two places computing it is two places that can drift.
   */
  banners: Map<string, number>;
  /** Which hero is the player's, so only that one takes orders. */
  youUid?: string;
}

/** Tiles a second. */
const WALK = 1.9;
const CHARGE = 2.4;
/** A hero walks a little faster, so a following retinue strings out behind. */
const HERO_WALK = 2.7;
/** Thirty ticks a second, matching the renderer's fixed step. */
const PER_TICK = 1 / 30;

const REACH = 0.9;
const CAST_REACH = 3.2;
const SWING_EVERY = 20;
const SWING_ANIM = 12;
const HURT_TICKS = 6;
const MARK_TICKS = 45;
const EFFECT_TICKS = 18;
/*
 * How often the Unmade arrive, and how many stand at once.
 *
 * Both raised, because a camp with a fault being worked on should look like it.
 * At the old rate one foe wandered in every three seconds and was put down
 * before the next arrived, so a besieged camp looked much like a quiet one --
 * which is the opposite of what the whole arrangement is for.
 */
const SPAWN_EVERY = 34;
const MAX_UNMADE = 40;
/** How many of the Unmade one camp can have at it before the rest hold back. */
const MAX_PER_CAMP = 7;

/** How often a soldier building something shows that it is. */
const BUILD_EVERY = 52;
/** Beyond this a fight is abandoned, and outside it none is started. */
const ABANDON_AT = 9;

/**
 * How far a soldier lets its hero get before it goes after them.
 *
 * Loose on purpose. A retinue that holds formation reads as a parade; one that
 * notices after a few paces and then hurries reads as people following someone.
 */
const LEASH = CAMP_RADIUS + 1.5;

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
    finished: 0,
    camps: new Map(),
    banners: new Map(),
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

/** Somewhere to stand around a point, on the apron rather than the middle. */
function spotAround(x: number, y: number, radius: number, seed: number): { x: number; y: number } {
  const angle = noise(seed) * Math.PI * 2;
  const distance = radius * (0.35 + noise(seed * 7) * 0.6);
  return { x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance * 0.85 };
}

function spotIn(garrison: Garrison, seed: number): { x: number; y: number } {
  return spotAround(garrison.x, garrison.y, garrison.radius, seed);
}

let nextEffect = 1;

function addEffect(sim: Sim, kind: Effect["kind"], x: number, y: number): void {
  sim.effects.push({ id: nextEffect++, kind, x, y, life: EFFECT_TICKS, maxLife: EFFECT_TICKS });
}

function addMark(sim: Sim, text: string, x: number, y: number, kind: Mark["kind"]): void {
  sim.marks.push({ id: nextEffect++, text, x, y, life: MARK_TICKS, maxLife: MARK_TICKS, kind });
}

/* ---- the roster ---------------------------------------------------------- */

export interface HeroInput {
  uid: string;
  name: string;
  /** The class they chose, which is only how their own figure is drawn. */
  characterClass: string;
}

export interface SoldierInput {
  id: string;
  name: string;
  /** The harness this session runs, which is the soldier's class. */
  kind: string;
  work: Work;
  /** Whose session it is. */
  heroUid: string;
  session?: Actor["session"];
}

/**
 * Brings the field in line with the team and its sessions, in one call.
 *
 * All at once rather than one muster at a time, because the camps have to be
 * solved for the whole roster: two members handed the same ground reads as a
 * rendering fault rather than as a crowded team, and that cannot be decided one
 * member at a time.
 *
 * It is idempotent, which the poll depends on. The roster arrives every few
 * seconds and is usually identical; anybody already on the field stays exactly
 * where they are, and only arrivals and departures cost anything.
 */
export function setRoster(
  sim: Sim,
  roster: { heroes: HeroInput[]; soldiers: SoldierInput[]; youUid?: string },
): void {
  sim.youUid = roster.youUid;
  sim.camps = assignCamps(roster.heroes.map((hero) => hero.uid));
  sim.banners = assignBanners(roster.heroes.map((hero) => hero.uid));

  const wanted = new Set<string>();

  for (const hero of roster.heroes) {
    const id = `hero-${hero.uid}`;
    wanted.add(id);
    const standing = sim.actors.find((actor) => actor.id === id);
    if (standing) {
      standing.name = hero.name;
      standing.kind = hero.characterClass || standing.kind;
      continue;
    }
    const camp = sim.camps.get(hero.uid) ?? { x: 64, y: 62 };
    sim.actors.push({
      id,
      side: "garrison",
      role: "hero",
      kind: hero.characterClass || "terminal",
      name: hero.name,
      work: "idle",
      x: camp.x,
      y: camp.y,
      toX: camp.x,
      toY: camp.y,
      facing: 1,
      moving: false,
      /*
       * A hero is a tank, and deliberately so.
       *
       * At sixty they had less in them than a single heisenbug has, so a camp
       * with a fault on it put its own person down inside a few seconds -- and
       * a hero is not a unit, it is somebody on the team. There is no death
       * here and nothing to lose, so the health bar is not a stake; it is a
       * read-out of how hard a camp is being hit. It has to survive a wave to
       * say anything at all, and at this it does.
       */
      hp: 420,
      maxHp: 420,
      hurt: 0,
      action: "stand",
      actionUntil: 0,
      rest: 0,
      home: "camp",
      heroUid: hero.uid,
    });
  }

  for (const soldier of roster.soldiers) {
    const id = `soldier-${soldier.id}`;
    wanted.add(id);
    const standing = sim.actors.find((actor) => actor.id === id);
    if (standing) {
      standing.work = soldier.work;
      standing.name = soldier.name;
      continue;
    }
    const camp = sim.camps.get(soldier.heroUid) ?? { x: 64, y: 62 };
    const spot = spotAround(camp.x, camp.y, CAMP_RADIUS, hashId(id));
    sim.actors.push({
      id,
      side: "garrison",
      role: "soldier",
      kind: soldier.kind,
      name: soldier.name,
      work: soldier.work,
      x: spot.x,
      y: spot.y,
      toX: spot.x,
      toY: spot.y,
      facing: 1,
      moving: false,
      hp: 20,
      maxHp: 20,
      hurt: 0,
      action: "stand",
      actionUntil: 0,
      rest: 0,
      home: "camp",
      heroUid: soldier.heroUid,
      session: soldier.session,
    });
  }

  /*
   * A soldier no longer on the roster has had its session close. It does not
   * vanish: it turns for the Barrow and walks there, and is taken off the field
   * when it arrives.
   *
   * Heroes do vanish, because a member leaving a team is an administrative fact
   * rather than an event on the map, and marching them to a graveyard would be
   * saying something quite different and untrue.
   */
  const barrow = GARRISONS.find((holding) => holding.id === "barrow");
  for (const actor of sim.actors) {
    if (actor.role !== "soldier" || wanted.has(actor.id)) continue;
    actor.role = "fallen";
    actor.targetId = undefined;
    actor.moving = true;
    actor.action = "walk";
    actor.toX = barrow?.x ?? 46;
    actor.toY = barrow?.y ?? 22;
    sim.finished += 1;
  }

  sim.actors = sim.actors.filter(
    (actor) => actor.role !== "hero" || wanted.has(actor.id),
  );
}

/** The player's own hero, if they have one on the field. */
export function yourHero(sim: Sim): Actor | undefined {
  if (!sim.youUid) return undefined;
  return sim.actors.find((actor) => actor.role === "hero" && actor.heroUid === sim.youUid);
}

/**
 * Orders a hero to walk somewhere.
 *
 * Only ever the player's own. Being able to march a colleague around the map
 * would be a toy, and it would be the only thing in this game that changes what
 * somebody else sees.
 */
export function orderHero(sim: Sim, x: number, y: number): boolean {
  const hero = yourHero(sim);
  if (!hero) return false;
  hero.toX = x;
  hero.toY = y;
  hero.moving = true;
  hero.ordered = true;
  hero.action = "walk";
  hero.rest = 0;
  return true;
}

/**
 * The garrison's own watch.
 *
 * Not sessions and never will be. They are here because a keep with five people
 * in it does not look like a keep, and a fault met by one wright does not look
 * like a battle. Clicking one says as much rather than pretending otherwise.
 */
export function garrisonSoldiers(sim: Sim): void {
  for (const garrison of GARRISONS) {
    const count = garrison.draws === "bug" ? 6 : 3;
    for (let index = 0; index < count; index += 1) {
      const id = `${garrison.id}-watch-${index}`;
      /* Calling this twice must not double the watch. */
      if (sim.actors.some((actor) => actor.id === id)) continue;
      const spot = spotIn(garrison, hashId(id));
      sim.actors.push({
        id,
        side: "garrison",
        role: "watch",
        kind: "soldier",
        name: `${garrison.name} watch`,
        work: "idle",
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

/* ---- the Unmade ---------------------------------------------------------- */

/*
 * How much the Unmade can take.
 *
 * Raised a long way. A camp has a hero hitting twice as hard as anybody else,
 * several soldiers, and the holding's own watch, so at the old figures a foe
 * arrived and was gone inside a second -- the fighting was a flicker of damage
 * numbers rather than anything you could watch. These last long enough to be a
 * fight, which is the whole point of drawing them.
 */
const UNMADE_KINDS = [
  { kind: "mite", hp: 22 },
  { kind: "crawler", hp: 48 },
  { kind: "heisenbug", hp: 90 },
];

/**
 * Which heroes have a fault being worked on, and so have something coming.
 *
 * Per hero, not per map. The Unmade are somebody's bugs: they come to the camp
 * of the person whose session is fixing something. A team where nobody is
 * fixing anything has a quiet map, which is the correct picture of a quiet day
 * and the reason a loud one means anything.
 */
export function besieged(sim: Sim): string[] {
  const under = new Set<string>();
  for (const actor of sim.actors) {
    if (actor.role !== "soldier" || actor.work !== "bug" || !actor.heroUid) continue;
    under.add(actor.heroUid);
  }
  return [...under].sort();
}

function spawnUnmade(sim: Sim, heroUid: string): void {
  const camp = sim.camps.get(heroUid);
  if (!camp) return;
  sim.spawned += 1;

  const roll = noise(sim.spawned * 977);
  const choice = UNMADE_KINDS[Math.min(2, Math.floor(roll * UNMADE_KINDS.length))];

  /* Out of the open country, from a different quarter each time. */
  const angle = noise(sim.spawned * 31) * Math.PI * 2;
  const distance = CAMP_RADIUS + 6 + noise(sim.spawned * 53) * 6;
  sim.actors.push({
    id: `unmade-${sim.spawned}`,
    side: "unmade",
    role: "unmade",
    kind: choice.kind,
    name: choice.kind,
    work: "bug",
    x: camp.x + Math.cos(angle) * distance,
    y: camp.y + Math.sin(angle) * distance * 0.85,
    toX: camp.x,
    toY: camp.y,
    facing: -1,
    moving: true,
    hp: choice.hp,
    maxHp: choice.hp,
    hurt: 0,
    action: "walk",
    actionUntil: 0,
    rest: 0,
    home: "camp",
    /* Whose fault it is, so it makes for the right camp. */
    heroUid,
  });
}

/* ---- fighting ------------------------------------------------------------ */

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
  /*
   * Bounded, so nobody sets off across the map after a fight two camps away.
   * Unbounded, one besieged camp pulled every soldier on the field towards it.
   */
  let bestDistance = ABANDON_AT;
  for (const other of sim.actors) {
    if (other.side === actor.side || other.hp <= 0) continue;
    /* Nobody harries the dead on their way to the Barrow. */
    if (other.role === "fallen") continue;
    const distance = Math.hypot(other.x - actor.x, other.y - actor.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = other;
    }
  }
  actor.targetId = best?.id;
  return best;
}

/**
 * A step towards a point, and out of anything it lands inside.
 *
 * Still no steering. Nothing here looks ahead or picks a way round, which is
 * the thing that made an earlier version shake; the step is taken exactly as it
 * always was and the result is then corrected by `pushOut`, which is a function
 * of position alone. Walking into a wall at an angle slides along it, because
 * the correction is perpendicular to the wall and the rest of the step lives.
 *
 * A figure walking straight at a wall slides nowhere, so a walk that ends up
 * covering almost none of its step counts as arrived rather than pressing
 * against the stone forever -- which is what a person does when the way is
 * shut.
 */
function stepTo(actor: Actor, toX: number, toY: number, speed: number): boolean {
  const step = speed * PER_TICK;
  const dx = toX - actor.x;
  const dy = toY - actor.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= step) {
    const landed = pushOut(toX, toY);
    actor.x = landed.x;
    actor.y = landed.y;
    return false;
  }

  const fromX = actor.x;
  const fromY = actor.y;
  const wantX = actor.x + (dx / distance) * step;
  const wantY = actor.y + (dy / distance) * step;
  const landed = pushOut(wantX, wantY);
  actor.x = landed.x;
  actor.y = landed.y;

  /* Face the way travelled, with a deadband so a stopped actor does not spin. */
  if (Math.abs(dx) > 0.02) actor.facing = dx > 0 ? 1 : -1;

  const moved = Math.hypot(actor.x - fromX, actor.y - fromY);
  return moved > step * 0.2;
}

/**
 * Where an actor belongs when there is nothing else to do.
 *
 * A soldier belongs wherever its hero is, which is what makes a retinue follow
 * rather than sit in an abandoned camp. Falling back to the camp covers the
 * moment between a hero leaving the roster and their soldiers going with them.
 */
function anchorFor(sim: Sim, actor: Actor, heroes: Map<string, Actor>): { x: number; y: number } {
  if (actor.role === "watch") {
    const garrison = GARRISONS.find((holding) => holding.id === actor.home) ?? GARRISONS[0];
    return { x: garrison.x, y: garrison.y };
  }
  if (actor.role === "hero" && actor.station) return actor.station;
  if (actor.heroUid) {
    if (actor.role === "soldier") {
      const hero = heroes.get(actor.heroUid);
      if (hero) return { x: hero.x, y: hero.y };
    }
    const camp = sim.camps.get(actor.heroUid);
    if (camp) return camp;
  }
  return { x: actor.x, y: actor.y };
}

function radiusFor(actor: Actor): number {
  if (actor.role !== "watch") return CAMP_RADIUS;
  const garrison = GARRISONS.find((holding) => holding.id === actor.home) ?? GARRISONS[0];
  return garrison.radius;
}

export function tickSim(sim: Sim): void {
  sim.clock += 1;

  /*
   * An index, built once a tick. A soldier has to find its hero every tick to
   * know where to stand, and scanning the whole field to do it is the sort of
   * quadratic that only shows up on somebody else's large team.
   */
  const heroes = new Map<string, Actor>();
  for (const actor of sim.actors) {
    if (actor.role === "hero" && actor.heroUid) heroes.set(actor.heroUid, actor);
  }

  const under = besieged(sim);
  if (under.length > 0 && sim.actors.filter((actor) => actor.side === "unmade").length < MAX_UNMADE) {
    sim.nextSpawn -= 1;
    if (sim.nextSpawn <= 0) {
      sim.nextSpawn = SPAWN_EVERY;
      /*
       * Round the besieged camps in turn, so one is not singled out, and skip
       * any that already has a crowd at it. Without the cap, a team where one
       * person is fixing everything drew the whole wave while everybody else's
       * camp stayed quiet.
       */
      for (let step = 0; step < under.length; step += 1) {
        const heroUid = under[(sim.spawned + step) % under.length];
        const already = sim.actors.filter(
          (actor) => actor.side === "unmade" && actor.heroUid === heroUid,
        ).length;
        if (already >= MAX_PER_CAMP) continue;
        spawnUnmade(sim, heroUid);
        break;
      }
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

    /*
     * The fallen walk to the Barrow and are taken off when they get there.
     *
     * They do not fight, are not fought, and answer to nothing else. A session
     * that has finished is finished.
     */
    if (actor.role === "fallen") {
      if (!stepTo(actor, actor.toX, actor.toY, WALK)) {
        actor.hp = 0;
      }
      continue;
    }

    /*
     * An order outranks everything.
     *
     * A hero who stops to fight whatever wanders past is a hero you cannot
     * steer, and steering is the one thing in this game the player actually
     * does. Their retinue keeps fighting; the hero goes where they were sent.
     */
    if (actor.ordered) {
      if (stepTo(actor, actor.toX, actor.toY, HERO_WALK)) {
        actor.moving = true;
        if (actor.action !== "attack") actor.action = "walk";
      } else {
        actor.moving = false;
        actor.ordered = false;
        actor.action = "stand";
        actor.rest = 30;
        /* Where they were sent is where they now hold. See `station`. */
        actor.station = { x: actor.x, y: actor.y };
      }
      continue;
    }

    /*
     * Who fights: the Unmade, heroes, the watch, and soldiers whose session is
     * on a fault. A soldier building a feature does not drop its work because
     * something walked past.
     */
    const fights =
      actor.role === "unmade" ||
      actor.role === "hero" ||
      actor.role === "watch" ||
      actor.work === "bug";

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
            /* A hero hits twice as hard as anyone they brought with them. */
            const damage = blow(actor.kind) * (actor.role === "hero" ? 2 : 1);
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

    /*
     * A soldier building something shows that it is.
     *
     * Not a mechanic: it raises no walls and unlocks nothing. It is here
     * because a camp where half the company is on features had nothing visible
     * happening in it, so feature work read as idling -- and a map where only
     * broken things move would quietly teach everybody that only broken things
     * count.
     */
    if (actor.role === "soldier" && actor.work === "feature") {
      if ((sim.clock + hashId(actor.id)) % BUILD_EVERY === 0) {
        addEffect(sim, "build", actor.x, actor.y);
        actor.action = "attack";
        actor.actionUntil = sim.clock + SWING_ANIM;
        sim.raised += 1;
      }
    }

    const anchor = anchorFor(sim, actor, heroes);
    const radius = radiusFor(actor);
    const away = Math.hypot(actor.x - anchor.x, actor.y - anchor.y);

    /*
     * Too far from where they belong: go there now, without waiting out the
     * rest. For a soldier that means their hero has walked off, and this is
     * the whole of what makes a retinue follow.
     */
    if (away > LEASH) {
      if (!actor.moving || Math.hypot(actor.toX - anchor.x, actor.toY - anchor.y) > LEASH) {
        const spot = spotAround(anchor.x, anchor.y, radius, hashId(actor.id) + sim.clock);
        actor.toX = spot.x;
        actor.toY = spot.y;
        actor.moving = true;
        actor.action = "walk";
      }
    } else if (!actor.moving) {
      actor.rest -= 1;
      if (actor.rest > 0) continue;
      const spot = spotAround(anchor.x, anchor.y, radius, hashId(actor.id) + sim.clock);
      actor.toX = spot.x;
      actor.toY = spot.y;
      actor.moving = true;
      actor.action = "walk";
      continue;
    }

    if (actor.moving && !stepTo(actor, actor.toX, actor.toY, actor.role === "hero" ? HERO_WALK : WALK)) {
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
     * Anybody who stands for something real comes back.
     *
     * A hero is a person and a soldier is a running session; neither stops
     * existing because something bit it. They are set back on their feet at
     * their camp, which reads as being driven off rather than killed. Only the
     * Unmade actually die, and theirs is the only death the game counts.
     */
    for (const dead of fallen) {
      if (dead.side === "unmade") continue;
      /* A session that finished stays finished. */
      if (dead.role === "fallen") continue;
      const home =
        dead.role === "watch"
          ? (GARRISONS.find((holding) => holding.id === dead.home) ?? GARRISONS[0])
          : { ...(sim.camps.get(dead.heroUid ?? "") ?? { x: 64, y: 62 }), radius: CAMP_RADIUS };
      const spot = spotAround(home.x, home.y, home.radius, hashId(dead.id) + sim.clock);
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
        ordered: false,
        targetId: undefined,
        rest: Math.round(60 + noise(hashId(dead.id)) * 60),
      });
    }
  }
}
