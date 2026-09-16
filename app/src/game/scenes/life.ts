import type { DrawContext } from "../engine/Stage";
import { TILE } from "../assets/terrain";
import { HOLDING, layout } from "./field";

/**
 * The things that move.
 *
 * Everything drawn here goes on the front canvas, cleared and redrawn thirty
 * times a second, while the ground and the buildings sit still underneath. It
 * is a short list on purpose: smoke from the chimney, the torches at the gate,
 * and the banner shifting on its pole. None of it is a game mechanic and none
 * of it can be interacted with.
 *
 * It earns its place because a still picture of a fort reads as a diagram no
 * matter how well it is drawn, and three moving things are enough to make the
 * same picture read as a place where something is happening. This is also the
 * cheapest possible proof that the loop, the clear, and the layering all work,
 * which is worth having before anything that matters is drawn on it.
 *
 * Every one of these is a pure function of the time passed in, with no state
 * of its own. That is what makes `motionless` a single early return rather
 * than a flag each effect has to remember to honour: hand it the same instant
 * every frame and the whole scene simply stops.
 */

/** Warm greys for smoke, palest first as it thins out. */
const SMOKE = ["#b58d5f", "#8f6a45", "#6a4a33"];

/** Pixel-aligned fill, so nothing here is drawn on a half pixel. */
function block(
  draw: DrawContext,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: string,
  alpha = 1,
): void {
  const { context, scale } = draw;
  context.save();
  context.globalAlpha = alpha;
  context.fillStyle = colour;
  context.fillRect(Math.round(x) * scale, Math.round(y) * scale, w * scale, h * scale);
  context.restore();
}

/**
 * Smoke from the hall's chimney.
 *
 * Four puffs on the same path at different points along it, each rising,
 * spreading and fading. Drawn as squares rather than circles because a circle
 * at this size is a square with the corners guessed at.
 */
function drawSmoke(draw: DrawContext, elapsedMs: number, originX: number, originY: number): void {
  const puffs = 4;
  const climb = 26;
  const period = 3200;

  for (let index = 0; index < puffs; index += 1) {
    const phase = ((elapsedMs / period) + index / puffs) % 1;
    const y = originY - phase * climb;
    /* Drifts east as it rises, the way smoke does when there is any wind. */
    const x = originX + phase * 5;
    const size = 1 + Math.floor(phase * 3);
    const colour = SMOKE[Math.min(SMOKE.length - 1, Math.floor(phase * SMOKE.length))];
    /* Fades out over the top half of the climb rather than all the way up. */
    const alpha = Math.max(0, 0.55 * (1 - Math.max(0, phase - 0.4) / 0.6));
    block(draw, x, y, size, size, colour, alpha);
  }
}

/**
 * A torch flame.
 *
 * Two shapes alternating on a period that is deliberately not a round number,
 * so two torches side by side do not flicker in step — that synchrony is the
 * thing that makes a row of torches read as a string of fairy lights.
 */
function drawFlame(draw: DrawContext, elapsedMs: number, x: number, y: number, seed: number): void {
  const phase = Math.floor((elapsedMs + seed * 137) / 110) % 2;
  const tall = phase === 0;

  /* The glow it throws, under everything else, so the flame sits inside it. */
  block(draw, x - 2, y - 1, 6, 6, "#f0a03c", 0.12);
  block(draw, x - 1, y, 4, 4, "#f0a03c", 0.14);

  if (tall) {
    block(draw, x, y - 2, 2, 2, "#f0a03c", 0.9);
    block(draw, x, y, 2, 2, "#c46b2a", 0.9);
  } else {
    block(draw, x, y - 1, 2, 2, "#f0a03c", 0.9);
    block(draw, x, y + 1, 2, 1, "#c46b2a", 0.9);
  }
}

/**
 * The banner, shifting on its pole.
 *
 * One pixel, twice: enough to read as cloth in the air and not enough to draw
 * the eye away from whatever is happening on the field.
 */
function drawBanner(draw: DrawContext, elapsedMs: number, x: number, y: number): void {
  const sway = Math.round(Math.sin(elapsedMs / 900) * 1.4);
  block(draw, x + sway, y, 7, 8, "#94441f", 0.85);
  block(draw, x + sway + 1, y + 2, 5, 4, "#c46b2a", 0.9);
}

export function drawLife(draw: DrawContext): void {
  /*
   * Stillness is honoured once, here. Every effect below is a function of the
   * clock, so not advancing the clock stops all of them, and no individual
   * effect has to remember that the setting exists.
   */
  if (draw.motionless) return;

  const { left, top } = layout(draw);
  const gateX = left + Math.floor(HOLDING.w / 2);
  const bottom = top + HOLDING.h - 1;

  /*
   * The chimney is six pixels in from the hall's north-west corner; see
   * buildKeep in assets/structures.ts, which puts it there.
   */
  const keepX = left + Math.floor((HOLDING.w - 3) / 2);
  const keepY = top + Math.floor((HOLDING.h - 3) / 2);
  drawSmoke(draw, draw.elapsedMs, keepX * TILE + 9, keepY * TILE + 6);

  /* The two torches either side of the gate. */
  drawFlame(draw, draw.elapsedMs, (gateX - 1) * TILE + 7, (bottom - 1) * TILE + 4, 0);
  drawFlame(draw, draw.elapsedMs, (gateX + 1) * TILE + 7, (bottom - 1) * TILE + 4, 3);

  drawBanner(draw, draw.elapsedMs, gateX * TILE + 4, (top + 2) * TILE + 2);
}
