import { Assets, Container, Graphics, Sprite, Texture } from "pixi.js";
import { depthOf, toScreen } from "./iso";
import { GARRISONS, MAP } from "../world/marches";
import type { Effect, Mark, Sim } from "../world/sim";

/**
 * Everything that is there to be looked at rather than played.
 *
 * Birds, smoke, the flash where a blow lands, the numbers that come off it.
 * None of it is a mechanic and none of it can be interacted with. It is here
 * because a map where the only thing moving is the thing you are watching
 * reads as a diagram of a place rather than a place.
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
