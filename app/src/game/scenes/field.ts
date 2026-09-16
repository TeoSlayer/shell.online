import { drawSprite } from "../engine/atlas";
import type { DrawContext } from "../engine/Stage";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "../engine/Stage";
import { STRUCTURES, type StructureName } from "../assets/structures";
import { TERRAIN, TILE, type TerrainName } from "../assets/terrain";

/**
 * The field: the ground, the keep, and whatever has been put up around it.
 *
 * Everything here is static -- it changes when somebody finishes a structure
 * and at no other time -- so it is drawn onto the back canvas and left alone.
 * The heroes and the bugs that move across it are drawn separately, every
 * frame, over the top.
 */

/** One thing standing on the field, in design pixels from the top left. */
export interface Placement {
  kind: StructureName;
  /** 1-based, matching how a tier is spoken about. */
  tier: number;
  x: number;
  /** The ground line the structure stands on; it is drawn up from here. */
  baseline: number;
}

export interface Base {
  ground: TerrainName;
  /** The courtyard the keep sits on, as a band across the field. */
  courtyard: { top: number; height: number };
  placements: Placement[];
}

/**
 * A starting holding: walls, a tower and a keep already standing.
 *
 * Deliberately not an empty plot. Somebody arriving at a bare field has
 * nothing to be proud of and nothing to improve; arriving at a small keep that
 * is visibly theirs gives the first upgrade something to be an upgrade *to*.
 */
export const STARTING_BASE: Base = {
  ground: "turf",
  courtyard: { top: 108, height: 48 },
  placements: [
    { kind: "wall", tier: 1, x: 16, baseline: 150 },
    { kind: "wall", tier: 1, x: 32, baseline: 150 },
    { kind: "watchtower", tier: 1, x: 56, baseline: 150 },
    { kind: "keep", tier: 1, x: 120, baseline: 150 },
    { kind: "watchtower", tier: 1, x: 224, baseline: 150 },
    { kind: "wall", tier: 1, x: 256, baseline: 150 },
    { kind: "wall", tier: 1, x: 272, baseline: 150 },
  ],
};

/** Tiles a rectangle of design pixels with one ground sprite. */
function tileArea(
  draw: DrawContext,
  terrain: TerrainName,
  top: number,
  height: number,
): void {
  const sprite = TERRAIN[terrain];
  for (let y = top; y < top + height; y += TILE) {
    for (let x = 0; x < DESIGN_WIDTH; x += TILE) {
      drawSprite(draw.context, sprite, x * draw.scale, y * draw.scale, { scale: draw.scale });
    }
  }
}

/**
 * The sky behind everything.
 *
 * Two flat bands with a dithered seam rather than a gradient. A smooth ramp
 * across 180 pixels would band anyway on most displays, and banding you did
 * not choose looks like a bug where banding you did choose looks like the art.
 */
function drawSky(draw: DrawContext): void {
  const { context, scale } = draw;
  const horizon = 96;
  context.fillStyle = "#161a2b";
  context.fillRect(0, 0, DESIGN_WIDTH * scale, horizon * scale);
  context.fillStyle = "#252c47";
  context.fillRect(0, (horizon - 12) * scale, DESIGN_WIDTH * scale, 12 * scale);

  /* The dithered seam: every other pixel of the lighter band, one row up. */
  context.fillStyle = "#252c47";
  for (let x = 0; x < DESIGN_WIDTH; x += 2) {
    context.fillRect(x * scale, (horizon - 14) * scale, scale, 2 * scale);
  }
}

export function drawField(draw: DrawContext, base: Base): void {
  drawSky(draw);
  tileArea(draw, base.ground, 96, DESIGN_HEIGHT - 96);
  tileArea(draw, "flagstone", base.courtyard.top, base.courtyard.height);

  /*
   * Drawn back to front by baseline, so a tower in front of the keep overlaps
   * it rather than the other way round. With everything currently on one line
   * this is a no-op; it is here because the first structure placed on a second
   * row is exactly when nobody remembers to add it.
   */
  const ordered = [...base.placements].sort((a, b) => a.baseline - b.baseline);
  for (const placement of ordered) {
    const art = STRUCTURES[placement.kind];
    const sprite = art.tiers[Math.min(placement.tier, art.tiers.length) - 1];
    if (!sprite) continue;
    drawSprite(
      draw.context,
      sprite,
      placement.x * draw.scale,
      (placement.baseline - sprite.h) * draw.scale,
      { scale: draw.scale },
    );
  }
}
