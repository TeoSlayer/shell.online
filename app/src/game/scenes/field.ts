import { drawShadow, drawSprite } from "../engine/atlas";
import type { DrawContext } from "../engine/Stage";
import {
  CORNER_TURNS,
  GATE,
  GATE_VERTICAL,
  KEEP_CORE,
  RAMPART,
  RAMPART_VERTICAL,
  WATCHTOWER,
} from "../assets/structures";
import { PROPS, WILD } from "../assets/props";
import { KERB, MEADOW, PAVING, ROAD, TILE, hash, type TerrainName } from "../assets/terrain";
import type { Sprite } from "../assets/sprite";

/**
 * The holding, seen from above and filling the window.
 *
 * There is no fixed frame here and no sky. A wider window sees more meadow
 * rather than the same picture stretched, which is what "the camera is above
 * it" actually means once you stop drawing a horizon.
 *
 * Everything in this module is static — it changes when somebody finishes a
 * structure and at no other time — so it is drawn onto the back canvas and
 * left alone. The heroes and the bugs that move across it are drawn separately
 * every frame, over the top.
 *
 * Three things do most of the work of making this look like a place rather
 * than a diagram, and all three live here rather than in the artwork:
 *
 *   Variants.  One grass tile repeated is a chequerboard the eye solves in a
 *              second. Four cuts, chosen by world position, break the period.
 *   Shadows.   Everything standing up casts one, down and to the right, so the
 *              map has a single light source and nothing floats.
 *   Props.     A cart by the gate and barrels against a wall are what say
 *              somebody actually uses this place.
 */

/** The walled holding, in tiles. Odd numbers, so there is a middle to stand in. */
const HOLDING_W = 13;
const HOLDING_H = 9;

export interface Base {
  ground: TerrainName;
  /** Ramparts and towers grow with the level; the keep has its own tier. */
  wallTier: number;
  keepTier: number;
  towerTier: number;
}

export const STARTING_BASE: Base = {
  ground: "grass",
  /*
   * Deliberately not an empty plot. Somebody arriving at bare ground has
   * nothing to be proud of and nothing to improve; arriving at a small holding
   * that is visibly theirs gives the first upgrade something to be an upgrade
   * to.
   */
  wallTier: 1,
  keepTier: 1,
  towerTier: 1,
};

/** Where the holding sits, in tiles, given how much ground is visible. */
export function layout(draw: DrawContext) {
  const cols = Math.ceil(draw.width / TILE);
  const rows = Math.ceil(draw.height / TILE);
  return {
    cols,
    rows,
    /* Centred, and snapped to the tile grid so nothing lands on a half. */
    left: Math.floor((cols - HOLDING_W) / 2),
    top: Math.floor((rows - HOLDING_H) / 2),
  };
}

type Holding = ReturnType<typeof layout>;

/** Screen position of a tile, in device pixels. */
function at(draw: DrawContext, tileX: number, tileY: number) {
  return { x: tileX * TILE * draw.scale, y: tileY * TILE * draw.scale };
}

function put(draw: DrawContext, sprite: Sprite, tileX: number, tileY: number): void {
  const { x, y } = at(draw, tileX, tileY);
  drawSprite(draw.context, sprite, x, y, { scale: draw.scale });
}

/**
 * Something standing on the ground, with its shadow under it.
 *
 * A sprite larger than a tile is centred on it and stood on its bottom edge,
 * rather than hung from its top-left corner. That is what lets a tree be
 * twenty-four pixels wide and still be *at* a particular tile: its trunk is on
 * the tile and its canopy overhangs whatever is next to it, which is how a
 * tree behaves.
 */
function stand(draw: DrawContext, sprite: Sprite, tileX: number, tileY: number, spread = 2): void {
  const { x, y } = at(draw, tileX, tileY);
  const offsetX = Math.round((TILE - sprite.w) / 2) * draw.scale;
  const offsetY = (TILE - sprite.h) * draw.scale;
  drawShadow(draw.context, sprite, x + offsetX, y + offsetY, draw.scale, spread);
  drawSprite(draw.context, sprite, x + offsetX, y + offsetY, { scale: draw.scale });
}

/**
 * A building that covers several tiles, drawn from the tile at its corner.
 *
 * Distinct from `stand` on purpose. A prop is a thing standing *at* a spot, so
 * it is centred on its tile and stood on the bottom edge of it; a building
 * *occupies* a block of tiles, and anchoring it the same way lifted the hall
 * two tiles clear of the courtyard it is supposed to be sitting in.
 */
function place(draw: DrawContext, sprite: Sprite, tileX: number, tileY: number, spread = 3): void {
  const { x, y } = at(draw, tileX, tileY);
  drawShadow(draw.context, sprite, x, y, draw.scale, spread);
  drawSprite(draw.context, sprite, x, y, { scale: draw.scale });
}

/** One of a set, chosen from where the tile is in the world. */
function pick<T>(options: T[], worldX: number, worldY: number, seed: number): T {
  const index = Math.floor(hash(worldX, worldY, seed) * options.length);
  return options[Math.min(index, options.length - 1)];
}

/**
 * The meadow, everywhere.
 *
 * Drawn across the whole visible area rather than a fixed rectangle: this is
 * what fills the window when somebody opens the game on an ultrawide.
 */
function drawGround(draw: DrawContext, holding: Holding): void {
  const { cols, rows, left, top } = holding;

  for (let y = -1; y < rows + 1; y += 1) {
    for (let x = -1; x < cols + 1; x += 1) {
      /*
       * Keyed on the tile's position relative to the holding rather than on
       * screen, so the field does not reshuffle itself when the window is
       * resized.
       */
      put(draw, pick(MEADOW, x - left, y - top, 77), x, y);
    }
  }
}

/** The road in through the gate, running south to the edge of the map. */
function drawRoad(draw: DrawContext, holding: Holding): void {
  const { rows, left, top } = holding;
  const gateX = left + Math.floor(HOLDING_W / 2);
  for (let y = top + HOLDING_H - 1; y < rows + 1; y += 1) {
    put(draw, pick(ROAD, 0, y - top, 55), gateX, y);
  }
}

/** Trees, rocks and bushes outside the walls, kept clear of the road. */
function drawWild(draw: DrawContext, holding: Holding): void {
  const { cols, rows, left, top } = holding;
  const right = left + HOLDING_W - 1;
  const bottom = top + HOLDING_H - 1;
  const gateX = left + Math.floor(HOLDING_W / 2);

  for (let y = -1; y < rows + 1; y += 1) {
    for (let x = -1; x < cols + 1; x += 1) {
      /* Nothing grows inside the walls, on the road, or right up against them. */
      const nearHolding = x >= left - 1 && x <= right + 1 && y >= top - 1 && y <= bottom + 1;
      if (nearHolding || x === gateX) continue;

      const roll = hash(x - left, y - top, 303);
      if (roll < 0.84) continue;
      stand(draw, pick(WILD, x - left, y - top, 404).sprite, x, y, roll > 0.96 ? 3 : 2);
    }
  }
}

/** The courtyard inside the walls, and the walls themselves. */
function drawHolding(draw: DrawContext, base: Base, holding: Holding): void {
  const { left, top } = holding;
  const right = left + HOLDING_W - 1;
  const bottom = top + HOLDING_H - 1;
  const tier = Math.max(1, base.wallTier) - 1;
  const rampart = RAMPART.tiers[Math.min(tier, RAMPART.tiers.length - 1)];
  const rampartV = RAMPART_VERTICAL[Math.min(tier, RAMPART_VERTICAL.length - 1)];
  const gateX = left + Math.floor(HOLDING_W / 2);

  /* Paving, in two cuts so a yard this size is not one stone repeated. */
  for (let y = top + 1; y < bottom; y += 1) {
    for (let x = left + 1; x < right; x += 1) {
      put(draw, pick(PAVING, x - left, y - top, 66), x, y);
    }
  }
  /* A kerb along the inside of the north wall, where the join would show. */
  for (let x = left + 1; x < right; x += 1) put(draw, KERB, x, top + 1);

  /* Ramparts along the four sides, with the gate set into the south wall. */
  for (let x = left + 1; x < right; x += 1) {
    stand(draw, rampart, x, top, 1);
    stand(draw, x === gateX ? GATE.tiers[0] : rampart, x, bottom, 1);
  }
  for (let y = top + 1; y < bottom; y += 1) {
    stand(draw, rampartV, left, y, 1);
    stand(draw, rampartV, right, y, 1);
  }

  /*
   * Corners, each at the orientation its turn needs. CORNER_TURNS is the one
   * authored corner rotated, so all four are the same masonry.
   */
  stand(draw, CORNER_TURNS[0], left, top, 1);
  stand(draw, CORNER_TURNS[1], right, top, 1);
  stand(draw, CORNER_TURNS[2], right, bottom, 1);
  stand(draw, CORNER_TURNS[3], left, bottom, 1);

  /* A watchtower inside each corner of the yard. */
  const tower =
    WATCHTOWER.tiers[Math.min(Math.max(1, base.towerTier) - 1, WATCHTOWER.tiers.length - 1)];
  stand(draw, tower, left + 1, top + 1);
  stand(draw, tower, right - 1, top + 1);
  stand(draw, tower, left + 1, bottom - 1);
  stand(draw, tower, right - 1, bottom - 1);

  /* The hall, three tiles square, in the middle of the yard. */
  const keep = KEEP_CORE.tiers[Math.min(Math.max(1, base.keepTier) - 1, KEEP_CORE.tiers.length - 1)];
  const keepX = left + Math.floor((HOLDING_W - 3) / 2);
  const keepY = top + Math.floor((HOLDING_H - 3) / 2);
  place(draw, keep, keepX, keepY, 3);

  /*
   * The yard's clutter, placed rather than scattered: stores against the side
   * walls, a well somebody has to walk to, a cart left by the gate, torches
   * either side of it and the holding's banner over the road.
   */
  stand(draw, PROPS.barrels.sprite, left + 2, top + 3, 1);
  stand(draw, PROPS.well.sprite, left + 2, top + 5);
  stand(draw, PROPS.crates.sprite, right - 2, top + 3, 1);
  stand(draw, PROPS.cart.sprite, right - 2, top + 5, 1);
  stand(draw, PROPS.torch.sprite, gateX - 1, bottom - 1, 1);
  stand(draw, PROPS.torch.sprite, gateX + 1, bottom - 1, 1);
  stand(draw, PROPS.banner.sprite, gateX, top + 2, 1);
}

export function drawField(draw: DrawContext, base: Base): void {
  const holding = layout(draw);
  drawGround(draw, holding);
  drawRoad(draw, holding);
  drawWild(draw, holding);
  drawHolding(draw, base, holding);
}

/** Named so the vertical gate is not dropped before the second gate uses it. */
export const GATE_NORTH_SOUTH = GATE_VERTICAL;

/**
 * The size of the holding, in tiles, for anything that needs to know where its
 * parts are without redrawing them.
 */
export const HOLDING = { w: HOLDING_W, h: HOLDING_H } as const;
