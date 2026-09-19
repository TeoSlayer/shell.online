import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { Application } from "pixi.js";
import { campLanterns, roadsideProps } from "../world/roadside";
import { depthOf, TILE_H, TILE_W, toScreen } from "../world/iso";

/**
 * Fences, hay bales and lanterns, and the light the lanterns throw.
 *
 * Drawn rather than sprited, because none of the three exists in the art.
 * Kenney's Medieval RTS pack is buildings, units, trees and rocks; the
 * medieval pack the repository owner supplied is flags, icons and a handful of
 * three-thousand-pixel renders. Neither has a rail fence, a bale or a
 * lamp-post, and all three are simple enough shapes that drawing them is
 * honest work rather than a stopgap: a bale is a cylinder on its side, a
 * lantern is a post with a light on it.
 *
 * Each shape is drawn once into a texture and then used as sprites. There are
 * several hundred of these and not one of them ever changes; a Graphics apiece
 * would be several hundred sets of geometry to hold and to walk, and a sprite
 * is one quad in a batch.
 *
 * The fences are baked once per direction. A rail has to run along the road,
 * and the roads curve now, so a single east-west section would sit across half
 * of them. Eight directions is close enough that the quantising does not show,
 * and it is eight textures rather than one per section.
 */

/** How many directions a fence section is baked in. See the note above. */
const FACINGS = 8;

/** The warm a lantern burns at, and what its light is tinted. */
const FLAME = 0xffd27a;
const GLOW = 0xffb454;

/**
 * A section of post-and-rail fence, running along a direction in tile space.
 *
 * Drawn in the projection rather than face-on. A fence lies *along* the ground,
 * unlike a tree or a person, so its run has to follow the diamond grid; drawn
 * face-on it reads as a picture of a fence standing on a floor.
 */
function drawFence(dx: number, dy: number): Graphics {
  const section = new Graphics();

  /** Half the run, in tiles. A section is a little over two tiles long. */
  const HALF = 1.05;
  const end = (sign: number) => ({
    x: (dx * HALF * sign - dy * HALF * sign) * (TILE_W / 2),
    y: (dx * HALF * sign + dy * HALF * sign) * (TILE_H / 2),
  });
  const left = end(-1);
  const right = end(1);

  /*
   * A post-and-rail fence, drawn as timber rather than as line art.
   *
   * The first version was three two-pixel posts and a pair of hairline strokes,
   * which at this distance is a handful of sticks lying in the grass. What made
   * it read as a fence is thickness and shading: a rail is a board with a lit
   * top edge and a dark underside, a post is a squared-off piece of wood with
   * one lit face and a cap, and there are enough posts that the rails look
   * carried rather than floating.
   */
  const POST_H = 30;
  const POSTS = 5;
  const RAILS = [POST_H * 0.80, POST_H * 0.44];

  const WOOD = 0x6f4a29;
  const WOOD_LIT = 0x9c7245;
  const WOOD_DARK = 0x4a2f19;

  /* Rails first, so the posts read as standing in front of them. */
  for (const lift of RAILS) {
    /* The underside, a touch below and darker: what gives a rail a thickness. */
    section
      .moveTo(left.x, left.y - lift + 2.5)
      .lineTo(right.x, right.y - lift + 2.5)
      .stroke({ color: WOOD_DARK, width: 5, cap: "round" });
    section
      .moveTo(left.x, left.y - lift)
      .lineTo(right.x, right.y - lift)
      .stroke({ color: WOOD, width: 5, cap: "round" });
    /* And the lit top edge, the same north-west light the ground is drawn with. */
    section
      .moveTo(left.x, left.y - lift - 1.4)
      .lineTo(right.x, right.y - lift - 1.4)
      .stroke({ color: WOOD_LIT, width: 1.6, cap: "round" });
  }

  for (let post = 0; post < POSTS; post += 1) {
    const t = post / (POSTS - 1);
    const px = left.x + (right.x - left.x) * t;
    const py = left.y + (right.y - left.y) * t;
    /* Squared timber: the shaded body, one lit face, and a cap on top. */
    section.rect(px - 3.5, py - POST_H, 7, POST_H).fill({ color: WOOD_DARK });
    section.rect(px - 3.5, py - POST_H, 3.5, POST_H).fill({ color: WOOD });
    section.rect(px - 3.5, py - POST_H, 1.6, POST_H).fill({ color: WOOD_LIT });
    section.ellipse(px, py - POST_H, 3.6, 1.7).fill({ color: WOOD_LIT });
  }

  return section;
}

/**
 * A round bale on its side: a body, a lit top, and the straw showing.
 *
 * Kept small. A bale is waist-high on a person, and this map has already been
 * through one round of things being drawn at the wrong scale.
 */
function drawBale(): Graphics {
  const bale = new Graphics();
  const W = 32;
  const H = 23;

  /* The drum on its side, lit from the north-west like everything else here. */
  bale.roundRect(-W / 2, -H, W, H, 9).fill({ color: 0xb08a3c });
  bale.roundRect(-W / 2, -H, W, H * 0.5, 9).fill({ color: 0xd2a84e });

  /* Straw, as a few strokes. Enough that it is not a bean; not so many that it
   * turns to noise at the size this is actually seen. */
  for (let line = 1; line < 4; line += 1) {
    const at = -H + (H / 4) * line;
    bale
      .moveTo(-W / 2 + 4, at)
      .lineTo(W / 2 - 4, at)
      .stroke({ color: 0x8f6c2b, width: 1.5, alpha: 0.7 });
  }

  /* The cut end, turned towards the viewer. */
  bale.ellipse(W / 2 - 6, -H / 2, 6, H / 2 - 1).fill({ color: 0xe0bc6a });
  bale.ellipse(W / 2 - 6, -H / 2, 2.5, H / 4).fill({ color: 0xa87f32 });

  return bale;
}

/** A lamp on a post: the post, the arm, the case, and the pane it burns behind. */
function drawLantern(): Graphics {
  const lamp = new Graphics();
  const POST = 44;

  lamp.rect(-2.5, -POST, 5, POST).fill({ color: 0x4a3722 });
  lamp.rect(-2.5, -POST, 2, POST).fill({ color: 0x695032 });
  /* The arm the case hangs off. */
  lamp.rect(-2.5, -POST, 13, 3.5).fill({ color: 0x4a3722 });

  lamp.rect(4, -POST + 3, 12, 15).fill({ color: 0x3a2b1a });
  lamp.rect(5.5, -POST + 5, 9, 11).fill({ color: FLAME });
  lamp.rect(2.5, -POST + 1, 15, 3).fill({ color: 0x5c452a });

  return lamp;
}

/**
 * The pool of light a lamp throws on the ground, baked.
 *
 * Two things about it were arrived at the hard way, and both are worth having
 * written down.
 *
 * It is an *ellipse* on the ground rather than a halo around the flame, and it
 * is drawn into its own layer just above the terrain -- under the people, the
 * buildings and the trees. That is where lamplight goes. Drawn over the top of
 * everything it washes out the figures standing in it, which is the opposite
 * of what a lamp does for the thing it is lighting.
 *
 * And it blends normally. The obvious choice is additive, and additive is what
 * this had first; on the WebGPU path Pixi maps `add` to a blend whose alpha
 * function is `[ONE, ONE]`, so every lamp also adds to the *canvas's* alpha
 * channel, the page composites the result, and the whole map comes back milky
 * -- not just the few yards near a lamp. `screen` is better and still hazes.
 * A warm translucent pool over dark ground reads as light perfectly well, and
 * it renders the same on every backend, which the other two do not.
 *
 * The falloff is a stack of concentric ellipses at small alphas. Pixi's
 * Graphics has no radial gradient worth the name, the overlaps accumulate into
 * a smooth edge, and as a texture the whole thing is one quad per lamp.
 */
function bakeGlow(app: Application): Texture {
  const pool = new Graphics();
  /*
   * Bigger and much brighter than it was.
   *
   * The whole argument for lighting this map at dusk is that the lamps are
   * what lift it back, and at a 120px pool of four percent a step they lifted
   * nothing: the ground under a lamp was the same colour as the ground twenty
   * tiles away, so every lamp on the map was an ornament rather than a light.
   * A wider pool with a hotter centre is what makes the verge it stands on
   * readable, which is the one job it has.
   */
  const R = 300;
  const STEPS = 26;
  for (let step = STEPS; step > 0; step -= 1) {
    const t = step / STEPS;
    /* Flattened to the 2:1 ground plane, like every other shadow on this map. */
    pool.ellipse(R, R / 2, R * t, (R * t) / 2).fill({ color: GLOW, alpha: 0.1 * (1 - t) ** 1.2 });
  }
  const texture = app.renderer.generateTexture(pool);
  pool.destroy();
  return texture;
}

/**
 * The flicker.
 *
 * A lamp that holds one exact brightness forever is a decal. A few percent of
 * wander at a rate slow enough not to read as a strobe is the difference
 * between a light and a picture of one.
 *
 * Each lamp gets its own phase and its own rate, so a road of them does not
 * pulse in unison, which would read as the whole map breathing.
 *
 * Under reduced motion they hold at full brightness rather than going out.
 * Everything else that moves on this map is ornament and is hidden outright;
 * a lamp is what makes the ground under it legible, so the setting takes the
 * movement and leaves the light.
 */
export class Lanterns {
  private readonly pools: { sprite: Sprite; base: number; phase: number; rate: number }[] = [];
  private elapsed = 0;
  private moving = true;

  add(sprite: Sprite, seed: number): void {
    const phase = (seed * 0.618) % 1;
    this.pools.push({
      sprite,
      base: sprite.alpha,
      phase: phase * Math.PI * 2,
      rate: 1.1 + phase * 1.4,
    });
  }

  still(stop: boolean): void {
    this.moving = !stop;
    if (stop) for (const pool of this.pools) pool.sprite.alpha = pool.base;
  }

  tick(deltaMs: number): void {
    if (!this.moving) return;
    this.elapsed += deltaMs / 1000;
    for (const pool of this.pools) {
      const wander = Math.sin(this.elapsed * pool.rate + pool.phase) * 0.5 + 0.5;
      pool.sprite.alpha = pool.base * (0.9 + wander * 0.14);
    }
  }
}

export interface Roadsides {
  /** The flat shadows, handed to the ground the way the scatter's are. */
  shadows: Graphics;
  /** Every camp's lamps and their light, by site key, for the scene to show. */
  campLights: Map<string, { lamps: Sprite[]; glow: Container }>;
  /** The lamps, so the scene can let them flicker and hold them still. */
  lanterns: Lanterns;
  count: number;
}

/**
 * `into` takes the sprites directly, and `lights` takes the glows.
 *
 * The sprites have to be siblings of the buildings and the people, because
 * depth is per sprite and a container of fences would sort as one thing. The
 * pools cannot be: they lie flat on the ground, under everything standing on
 * it, and they are the one layer that dusk is not applied to -- light that is
 * itself dimmed is not light.
 */
export function buildRoadside(
  app: Application,
  into: Container,
  lights: Container,
): Roadsides {
  const shadows = new Graphics();
  const campLights = new Map<string, { lamps: Sprite[]; glow: Container }>();
  const lanterns = new Lanterns();

  /*
   * Baked once each. `generateTexture` renders a Graphics to an offscreen
   * target, which is why these are drawn and then thrown away.
   */
  const facings: Texture[] = [];
  for (let facing = 0; facing < FACINGS; facing += 1) {
    const angle = (facing / FACINGS) * Math.PI * 2;
    const shape = drawFence(Math.cos(angle), Math.sin(angle));
    facings.push(app.renderer.generateTexture(shape));
    shape.destroy();
  }

  const bake = (shape: Graphics) => {
    const texture = app.renderer.generateTexture(shape);
    shape.destroy();
    return texture;
  };
  const baleTexture = bake(drawBale());
  const lampTexture = bake(drawLantern());
  const glowTexture = bakeGlow(app);

  /** The pool a lamp casts, lying on the ground at the foot of its post. */
  const lightAt = (tileX: number, tileY: number, scale: number, parent: Container) => {
    const at = toScreen(tileX, tileY);
    const light = new Sprite(glowTexture);
    light.anchor.set(0.5);
    light.scale.set(scale);
    light.position.set(at.x, at.y + TILE_H * 0.15);
    parent.addChild(light);
    /* Seeded from where it stands, so a lamp flickers the same way every time. */
    lanterns.add(light, Math.abs(Math.round(tileX * 131 + tileY)));
  };

  /** Something standing at a tile, sorted against everything else on it. */
  const stand = (texture: Texture, tileX: number, tileY: number) => {
    const at = toScreen(tileX, tileY);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    sprite.position.set(at.x, at.y + TILE_H * 0.2);
    sprite.zIndex = depthOf(tileX, tileY);
    into.addChild(sprite);
    return sprite;
  };

  const placed = roadsideProps();
  for (const prop of placed) {
    if (prop.kind === "fence") {
      /*
       * The facing, quantised. `atan2` gives -PI..PI; the double modulo puts a
       * negative bucket back in range, which is the shortest correct way to do
       * it and the reason this is not a bare `%`.
       */
      const angle = Math.atan2(prop.dy, prop.dx);
      const bucket = ((Math.round((angle / (Math.PI * 2)) * FACINGS) % FACINGS) + FACINGS) % FACINGS;
      stand(facings[bucket], prop.x, prop.y);
    } else if (prop.kind === "bale") {
      stand(baleTexture, prop.x, prop.y);
    } else {
      stand(lampTexture, prop.x, prop.y);
      lightAt(prop.x, prop.y, 1, lights);
    }
  }

  shadows.fill({ color: 0x1a1008, alpha: 0.22 });

  /*
   * The camps' lamps, kept apart from the rest.
   *
   * A camp is only there while somebody holds it, so its lamps are only lit
   * while somebody holds it -- an unheld camp still burning says somebody is
   * standing there who is not. Both the posts and their light are collected
   * per site so the scene can show them with the camp.
   */
  for (const lamp of campLanterns()) {
    const sprite = stand(lampTexture, lamp.x, lamp.y);
    sprite.visible = false;

    let group = campLights.get(lamp.site);
    if (!group) {
      const glow = new Container();
      glow.visible = false;
      lights.addChild(glow);
      group = { lamps: [], glow };
      campLights.set(lamp.site, group);
    }
    group.lamps.push(sprite);
    /*
     * Brighter and wider than a roadside lamp. This pair is what makes the
     * banners standing beside it readable, which is the whole reason the camps
     * were given lamps.
     */
    lightAt(lamp.x, lamp.y, 1.45, group.glow);
  }

  return { shadows, campLights, lanterns, count: placed.length };
}
