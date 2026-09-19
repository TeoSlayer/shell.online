import { Assets, Container, Graphics, Sprite, Texture } from "pixi.js";
import { depthOf, toScreen } from "../world/iso";
import { GARRISONS, groundTiles, MAP, type Ground } from "../world/marches";
import type { Actor, Effect, Mark, Sim } from "../world/sim";

/**
 * Everything that is there to be looked at rather than played.
 *
 * Birds, smoke, dust off a walker's heels, the flash where a blow lands and the
 * numbers that come off it. None of it is a mechanic and none of it can be
 * interacted with. It is here because a map where the only thing moving is the
 * thing you are watching reads as a diagram of a place rather than a place.
 *
 * All of it answers to `still()`. Drifting particles and things that flap are
 * named in the game-ui-design rules as motion-sickness triggers, and until this
 * existed the reduced-motion setting reached the interface and stopped at the
 * edge of the canvas -- so somebody who had asked for less motion got a still
 * HUD over a map full of it, which is the setting doing nothing where it
 * matters most.
 */

/** Particle textures, vendored from Kenney's CC0 pack. See the notices file. */
const FX_TEXTURES = ["fx-smoke_01", "fx-star_04", "fx-flare_01", "fx-spark_04", "fx-magic_05"];

export async function loadEffects(): Promise<Record<string, Texture>> {
  const loaded: Record<string, Texture> = {};
  await Promise.all(
    FX_TEXTURES.map(async (name) => {
      loaded[name] = await Assets.load(`/game/${name}.png`);
    }),
  );
  return loaded;
}

/* ---- birds --------------------------------------------------------------- */

interface Bird {
  sprite: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
}

/**
 * Birds, drawn rather than sprited.
 *
 * A bird at this distance is two strokes that open and close. Kenney has no
 * bird and a five-pixel drawing of one would be a smudge; two lines that flap
 * read as a bird from any distance and cost a handful of vertices.
 *
 * They fly above everything, cast no shadow, and are pushed to a depth beyond
 * anything on the ground, which is what makes them read as being in the air
 * rather than walking about on it.
 */
export class Birds {
  private readonly birds: Bird[] = [];
  private readonly layer = new Container();
  private moving = true;

  /** Off, and out of the sky: a frozen bird is stranger than no bird. */
  still(stop: boolean): void {
    this.moving = !stop;
    this.layer.visible = !stop;
  }

  constructor(parent: Container, count = 14) {
    parent.addChild(this.layer);
    this.layer.zIndex = depthOf(MAP.width, MAP.height, 9_000);

    for (let index = 0; index < count; index += 1) {
      const sprite = new Graphics();
      this.layer.addChild(sprite);
      /* Spread over the whole map, drifting on roughly the same wind. */
      this.birds.push({
        sprite,
        x: Math.random() * MAP.width,
        y: Math.random() * MAP.height,
        vx: 0.35 + Math.random() * 0.5,
        vy: -0.12 + Math.random() * 0.24,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  tick(deltaMs: number): void {
    if (!this.moving) return;
    const seconds = deltaMs / 1000;
    for (const bird of this.birds) {
      bird.x += bird.vx * seconds;
      bird.y += bird.vy * seconds;
      bird.phase += seconds * 9;

      /* Off one edge and back on the other, so the sky is never empty. */
      if (bird.x > MAP.width + 4) bird.x = -4;
      if (bird.y < -4) bird.y = MAP.height + 4;
      if (bird.y > MAP.height + 4) bird.y = -4;

      const { x, y } = toScreen(bird.x, bird.y);
      /* Height above the ground, which is what the projection cannot give us. */
      const lift = 54 + Math.sin(bird.phase / 3) * 6;
      const flap = Math.sin(bird.phase) * 4;

      bird.sprite.clear();
      bird.sprite
        .moveTo(x - 6, y - lift)
        .lineTo(x - 2, y - lift - flap)
        .lineTo(x + 2, y - lift)
        .stroke({ color: 0x2b1d16, width: 2, alpha: 0.75 });
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}

/* ---- chimney smoke ------------------------------------------------------- */

/**
 * Smoke over the holdings, so the map looks inhabited from a distance.
 *
 * One drifting column per garrison, made of a handful of sprites recycled
 * rather than created and destroyed — a particle system that allocates is a
 * particle system that stutters.
 */
export class Smoke {
  private readonly puffs: { sprite: Sprite; life: number; x: number; y: number; from: number }[] = [];
  private readonly layer = new Container();
  private moving = true;

  /**
   * Held rather than hidden.
   *
   * Smoke standing still over a chimney still says the holding is lived in,
   * which is the whole job; it is the drift that is the problem. So the column
   * stops where it is instead of disappearing.
   */
  still(stop: boolean): void {
    this.moving = !stop;
  }

  constructor(parent: Container, texture: Texture, perGarrison = 5) {
    parent.addChild(this.layer);
    this.layer.zIndex = depthOf(MAP.width, MAP.height, 8_000);

    GARRISONS.forEach((garrison, index) => {
      for (let puff = 0; puff < perGarrison; puff += 1) {
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5);
        sprite.alpha = 0;
        this.layer.addChild(sprite);
        this.puffs.push({
          sprite,
          /* Staggered, so a chimney does not cough all its smoke at once. */
          life: (puff / perGarrison) * 100,
          x: garrison.x,
          y: garrison.y - 1,
          from: index,
        });
      }
    });
  }

  tick(deltaMs: number): void {
    if (!this.moving) return;
    const step = deltaMs / 1000;
    for (const puff of this.puffs) {
      puff.life += step * 22;
      if (puff.life > 100) puff.life = 0;

      const progress = puff.life / 100;
      const { x, y } = toScreen(puff.x, puff.y);
      puff.sprite.position.set(x + progress * 26, y - 40 - progress * 46);
      puff.sprite.scale.set(0.12 + progress * 0.3);
      puff.sprite.alpha = Math.max(0, 0.38 * (1 - progress));
      puff.sprite.tint = 0xd9c9b0;
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}

/* ---- dust ---------------------------------------------------------------- */

/** What the ground gives up when it is walked on. Water gives up nothing. */
const DUST_TINT: Record<Ground, number> = {
  /*
   * Lighter than the ground each comes off, not the same colour as it. Dust
   * matching the road exactly is dust you cannot see; what makes it read is
   * that it is the ground caught in the light.
   */
  dirt: 0xe3c79b,
  sand: 0xf4e8c4,
  stone: 0xd8d2c8,
  grass: 0xcfdbb0,
  water: 0x000000,
};

interface Puff {
  sprite: Sprite;
  /** Counts down. At or below zero the puff is free to be used again. */
  life: number;
  maxLife: number;
  x: number;
  y: number;
  driftX: number;
  driftY: number;
}

/**
 * Dust off the heels of anything walking.
 *
 * This is the cheapest thing in the game that most changes how it feels. A
 * figure crossing open ground with nothing coming off it is a sprite being
 * moved; the same figure trailing a little dust is somebody walking, and the
 * difference is about forty lines.
 *
 * The pool is fixed and allocated once. A fight with thirty walkers in it can
 * ask for a puff several times a second, and a particle system that allocates
 * is a particle system that stutters -- when the pool is empty the request is
 * simply dropped, which nobody can see and which cannot cost anything.
 *
 * Each puff is tinted by the ground under the foot that raised it, so crossing
 * from a road onto grass changes the colour of what comes up. That is a detail
 * almost nobody will notice, and the reason to do it anyway is that the ones
 * nobody notices are what the noticeable ones are made of.
 */
export class Dust {
  private readonly puffs: Puff[] = [];
  private readonly cooldown = new Map<string, number>();
  private moving = true;

  constructor(
    private readonly parent: Container,
    texture: Texture,
    size = 80,
  ) {
    for (let index = 0; index < size; index += 1) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5, 0.5);
      sprite.alpha = 0;
      sprite.visible = false;
      parent.addChild(sprite);
      this.puffs.push({ sprite, life: 0, maxLife: 1, x: 0, y: 0, driftX: 0, driftY: 0 });
    }
  }

  /** Off entirely. Dust is drift, and drift is the thing being asked about. */
  still(stop: boolean): void {
    this.moving = !stop;
    if (!stop) return;
    for (const puff of this.puffs) {
      puff.life = 0;
      puff.sprite.visible = false;
    }
  }

  tick(sim: Sim, deltaMs: number): void {
    const seconds = Math.min(0.1, deltaMs / 1000);

    for (const puff of this.puffs) {
      if (puff.life <= 0) continue;
      puff.life -= seconds;
      if (puff.life <= 0) {
        puff.sprite.visible = false;
        continue;
      }
      puff.x += puff.driftX * seconds;
      puff.y += puff.driftY * seconds;

      const progress = 1 - puff.life / puff.maxLife;
      const { x, y } = toScreen(puff.x, puff.y);
      puff.sprite.position.set(x, y + 4 - progress * 10);
      puff.sprite.scale.set(0.08 + progress * 0.2);
      puff.sprite.alpha = 0.5 * (1 - progress);
      /* Under the feet that raised it, and over the ground it came off. */
      puff.sprite.zIndex = depthOf(puff.x, puff.y, 5);
    }

    if (!this.moving) return;

    for (const actor of sim.actors) {
      const left = (this.cooldown.get(actor.id) ?? 0) - seconds;
      if (!actor.moving) {
        /* Standing still: hold the timer at zero so the next step raises dust. */
        this.cooldown.set(actor.id, 0);
        continue;
      }
      if (left > 0) {
        this.cooldown.set(actor.id, left);
        continue;
      }
      this.cooldown.set(actor.id, 0.16 + Math.random() * 0.1);
      this.raise(actor);
    }
  }

  private raise(actor: Actor): void {
    const tiles = groundTiles();
    const tx = Math.round(actor.x);
    const ty = Math.round(actor.y);
    if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) return;
    const ground = tiles[ty * MAP.width + tx];
    if (ground === "water") return;

    const puff = this.puffs.find((candidate) => candidate.life <= 0);
    /* Nothing free: drop it. A missing puff is invisible; a stutter is not. */
    if (!puff) return;

    puff.maxLife = 0.5 + Math.random() * 0.3;
    puff.life = puff.maxLife;
    puff.x = actor.x;
    puff.y = actor.y;
    /* Backwards from the way they are facing, and drifting apart as it rises. */
    puff.driftX = -actor.facing * (0.25 + Math.random() * 0.3);
    puff.driftY = (Math.random() - 0.5) * 0.3;

    puff.sprite.visible = true;
    puff.sprite.tint = DUST_TINT[ground];
    puff.sprite.alpha = 0.42;
    puff.sprite.rotation = Math.random() * Math.PI;
  }

  destroy(): void {
    for (const puff of this.puffs) puff.sprite.destroy();
    this.puffs.length = 0;
    this.cooldown.clear();
    this.parent.sortDirty = true;
  }
}

/* ---- blows, and the numbers that come off them --------------------------- */

/**
 * The flash where something was struck, and the number that rises off it.
 *
 * Both are pooled: a fight can produce a dozen a second, and creating a Text
 * object per hit is the fastest way to make a Pixi scene stutter, because each
 * one uploads a new texture.
 */
export class Blows {
  private readonly layer = new Container();
  private readonly flashes = new Map<number, Sprite>();
  private readonly numbers = new Map<number, Container>();

  constructor(
    parent: Container,
    private readonly textures: Record<string, Texture>,
    private readonly makeNumber: (text: string, kind: Mark["kind"]) => Container,
  ) {
    parent.addChild(this.layer);
    this.layer.zIndex = depthOf(MAP.width, MAP.height, 7_000);
  }

  sync(sim: Sim): void {
    const liveEffects = new Set<number>();
    for (const effect of sim.effects) {
      liveEffects.add(effect.id);
      let sprite = this.flashes.get(effect.id);
      if (!sprite) {
        sprite = new Sprite(this.pick(effect));
        sprite.anchor.set(0.5);
        sprite.blendMode = "add";
        this.layer.addChild(sprite);
        this.flashes.set(effect.id, sprite);
      }
      const progress = 1 - effect.life / effect.maxLife;
      const { x, y } = toScreen(effect.x, effect.y);
      sprite.position.set(x, y - 18);
      sprite.scale.set(0.16 + progress * 0.4);
      sprite.alpha = 1 - progress;
      sprite.rotation = progress * 1.2;
    }
    for (const [id, sprite] of this.flashes) {
      if (liveEffects.has(id)) continue;
      sprite.destroy();
      this.flashes.delete(id);
    }

    const liveMarks = new Set<number>();
    for (const mark of sim.marks) {
      liveMarks.add(mark.id);
      let node = this.numbers.get(mark.id);
      if (!node) {
        node = this.makeNumber(mark.text, mark.kind);
        this.layer.addChild(node);
        this.numbers.set(mark.id, node);
      }
      const progress = 1 - mark.life / mark.maxLife;
      const { x, y } = toScreen(mark.x, mark.y);
      node.position.set(x, y - 30 - progress * 34);
      node.alpha = Math.min(1, (1 - progress) * 2.2);
    }
    for (const [id, node] of this.numbers) {
      if (liveMarks.has(id)) continue;
      node.destroy({ children: true });
      this.numbers.delete(id);
    }
  }

  private pick(effect: Effect): Texture {
    switch (effect.kind) {
      case "cast":
        return this.textures["fx-magic_05"] ?? this.textures["fx-star_04"];
      case "fell":
        return this.textures["fx-flare_01"];
      case "build":
        return this.textures["fx-spark_04"];
      default:
        return this.textures["fx-star_04"];
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}
