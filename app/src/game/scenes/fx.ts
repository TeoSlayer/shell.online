import type { DrawContext } from "../engine/Stage";
import { TILE } from "../assets/terrain";
import type { Bolt, Spark, World } from "../state/world";

/**
 * Bolts in the air and bursts where something was struck.
 *
 * Drawn with fills rather than sprites. These are three or four pixels that
 * exist for a third of a second, and a sprite for each would be artwork
 * nobody can see well enough to appreciate — the shape that reads at this size
 * and duration is a bright block and a couple of chips flying off it.
 *
 * All of it is a pure function of the world's clock, so a paused game freezes
 * mid-burst rather than swallowing the effect.
 */

function block(
  draw: DrawContext,
  x: number,
  y: number,
  size: number,
  colour: string,
  alpha = 1,
): void {
  const { context, scale } = draw;
  context.save();
  context.globalAlpha = alpha;
  context.fillStyle = colour;
  context.fillRect(Math.round(x) * scale, Math.round(y) * scale, size * scale, size * scale);
  context.restore();
}

/**
 * A bolt, drawn as a head with a short tail behind it.
 *
 * The tail is three blocks along the path it has already covered, which at
 * this speed reads as a streak without needing motion blur or a gradient —
 * both of which would look wrong beside hard-edged pixel art.
 */
function drawBolt(draw: DrawContext, bolt: Bolt): void {
  const progress = 1 - bolt.life / bolt.maxLife;
  const x = bolt.x + (bolt.toX - bolt.x) * progress;
  const y = bolt.y + (bolt.toY - bolt.y) * progress;

  for (let step = 0; step < 3; step += 1) {
    const back = Math.max(0, progress - step * 0.08);
    const tailX = bolt.x + (bolt.toX - bolt.x) * back;
    const tailY = bolt.y + (bolt.toY - bolt.y) * back;
    block(
      draw,
      tailX * TILE + TILE / 2 - 1,
      tailY * TILE + TILE / 2 - 5,
      2,
      step === 0 ? "#b4bdd8" : "#4267f5",
      1 - step * 0.28,
    );
  }
  /* The head, brightest, on top of its own tail. */
  block(draw, x * TILE + TILE / 2 - 1, y * TILE + TILE / 2 - 5, 3, "#eef1fb", 0.95);
}

/**
 * A burst.
 *
 * Four chips thrown out from the middle, further and fainter as it ages. Hits
 * throw cold colours because that is what the Unmade are made of; a hammer
 * throws warm stone chips, because that is what it is hitting.
 */
function drawSpark(draw: DrawContext, spark: Spark): void {
  const progress = 1 - spark.life / spark.maxLife;
  const spread = 1 + progress * 5;
  const alpha = 1 - progress;
  const colours =
    spark.kind === "hit" ? ["#ff6fd8", "#48d6c0"] : ["#d9b88a", "#8f6a45"];

  const centreX = spark.x * TILE + TILE / 2;
  const centreY = spark.y * TILE + TILE / 2;

  /* Fixed diagonals rather than random ones, so it is the same burst twice. */
  const chips = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  chips.forEach(([dx, dy], index) => {
    block(
      draw,
      centreX + dx * spread - 1,
      centreY + dy * spread - 1,
      2,
      colours[index % colours.length],
      alpha,
    );
  });
  /* A bright core for the first half, so the moment of impact has weight. */
  if (progress < 0.5) {
    block(draw, centreX - 1, centreY - 1, 3, colours[0], 1 - progress * 2);
  }
}

export function drawFx(draw: DrawContext, world: World): void {
  for (const bolt of world.bolts) drawBolt(draw, bolt);
  for (const spark of world.sparks) drawSpark(draw, spark);
}
