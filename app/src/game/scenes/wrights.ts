import { drawAnimation } from "../engine/atlas";
import type { DrawContext } from "../engine/Stage";
import { heroArt } from "../assets/heroes";
import { SHADOW } from "../assets/palette";
import { TILE } from "../assets/terrain";
import type { Wright, World } from "../state/world";

/**
 * The garrison, drawn over the field.
 *
 * Wrights are the only things on screen that move under their own steam, so
 * they get the whole front canvas to themselves and are redrawn every frame.
 * Everything here reads the world and draws it; nothing here changes it, which
 * is what keeps "what is happening" and "what it looks like" separable.
 */

/** Wrights are drawn standing on the middle of their tile, not its corner. */
function screenPosition(draw: DrawContext, wright: Wright, height: number) {
  return {
    x: (wright.x * TILE + TILE / 2 - 8) * draw.scale,
    /* Feet on the tile, so a taller sprite grows upwards. */
    y: (wright.y * TILE + TILE - height) * draw.scale,
  };
}

/**
 * The plate under a wright with their session's name on it.
 *
 * Drawn on the canvas rather than in the DOM: there may be forty of these, one
 * per session, and forty absolutely-positioned elements tracking moving canvas
 * coordinates is a layout thrash the browser does not deserve. Canvas text is
 * the right tool the moment a label has to follow something that moves.
 *
 * A dark plate behind it and a hard outline on it, because it sits over grass,
 * over paving and over a fire, and it has to stay readable on all three.
 */
function drawPlate(draw: DrawContext, label: string, x: number, y: number): void {
  const { context, scale } = draw;
  /*
   * Deliberately not scaled with the pixel art. Names are read, not looked at,
   * and shrinking them to four pixels tall for authenticity would make the one
   * piece of real information on the field the least legible thing on it.
   */
  const size = Math.max(11, 4 * scale);

  context.save();
  context.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textAlign = "center";
  context.textBaseline = "top";

  const width = context.measureText(label).width;
  const padding = Math.round(scale * 1.5);
  const plateX = x - width / 2 - padding;
  const plateY = y + padding;

  context.globalAlpha = 0.72;
  context.fillStyle = "#160f0c";
  context.fillRect(plateX, plateY, width + padding * 2, size + padding);
  context.globalAlpha = 1;

  context.lineWidth = Math.max(2, scale / 2);
  context.strokeStyle = "#160f0c";
  context.strokeText(label, x, plateY + padding / 2);
  context.fillStyle = "#f5e3c0";
  context.fillText(label, x, plateY + padding / 2);
  context.restore();
}

/**
 * A mark over the wright's head saying what the session is doing.
 *
 * Shape and colour together, never colour alone: a cross for a fault being
 * fought, a square for something being built. Somebody who cannot separate the
 * two colours can still separate the two shapes.
 */
function drawTask(draw: DrawContext, wright: Wright, x: number, y: number): void {
  if (wright.work === "idle") return;
  const { context, scale } = draw;
  const size = 3 * scale;
  const top = y - size - scale;

  context.save();
  context.fillStyle = "#160f0c";
  context.fillRect(x - size / 2 - scale, top - scale, size + scale * 2, size + scale * 2);

  if (wright.work === "bug") {
    /* A cross: something is being struck. */
    context.fillStyle = "#c0392b";
    context.fillRect(x - size / 2, top + size / 3, size, size / 3);
    context.fillRect(x - size / 6, top, size / 3, size);
  } else {
    /* A square: something is being raised. */
    context.fillStyle = "#f0a03c";
    context.fillRect(x - size / 2, top, size, size);
    context.fillStyle = "#160f0c";
    context.fillRect(x - size / 4, top + size / 3, size / 2, size / 3);
  }
  context.restore();
}

/** A plate waiting to be drawn, once it is known what else is near it. */
interface Plate {
  label: string;
  x: number;
  y: number;
  halfWidth: number;
}

/**
 * Moves plates apart so none is drawn on top of another.
 *
 * Five wrights standing near each other produced five labels in the same
 * place, and a stack of overlapping text is worse than no text at all: it
 * hides the one piece of real information on the field behind itself. Each
 * plate that would land on one already placed is pushed down until it clears,
 * which keeps every name readable and keeps it near whoever it belongs to.
 *
 * Exported so the rule can be tested without a canvas.
 */
export function spreadPlates(plates: Plate[], lineHeight: number): Plate[] {
  const placed: Plate[] = [];
  /* Higher up the field first, so the pushing goes downwards and stays stable. */
  for (const plate of [...plates].sort((a, b) => a.y - b.y)) {
    let { y } = plate;
    let moved = true;
    /* Bounded: with N plates the worst case is N pushes, never a loop. */
    for (let guard = 0; moved && guard <= placed.length; guard += 1) {
      moved = false;
      for (const other of placed) {
        const overlapsX = Math.abs(other.x - plate.x) < other.halfWidth + plate.halfWidth;
        const overlapsY = Math.abs(other.y - y) < lineHeight;
        if (overlapsX && overlapsY) {
          y = other.y + lineHeight;
          moved = true;
        }
      }
    }
    placed.push({ ...plate, y });
  }
  return placed;
}

export function drawWrights(draw: DrawContext, world: World): void {
  /*
   * Back to front, so somebody standing lower on the map overlaps somebody
   * standing higher. Without this, two wrights crossing pass through each
   * other in whichever order the array happens to hold them.
   */
  const ordered = [...world.wrights].sort((a, b) => a.y - b.y);
  const plates: Plate[] = [];

  for (const wright of ordered) {
    const art = heroArt(wright.kind);
    const animation = wright.moving ? art.walk : art.idle;
    const height = animation.sprite.h;
    const { x, y } = screenPosition(draw, wright, height);

    /*
     * The clock comes from the world rather than from the wall, so pausing the
     * game stops the animation: a paused world stops ticking, the clock stops
     * advancing, and every wright holds their frame.
     */
    const elapsed = (world.clock / 30) * 1000;

    /*
     * The shadow is the same call with a flat palette, not drawShadow: that
     * takes a whole sprite, and an animation's sprite is the entire strip, so
     * a wright would have cast a shadow four frames wide.
     */
    drawAnimation(draw.context, animation, x + draw.scale, y + draw.scale, elapsed, {
      scale: draw.scale,
      palette: SHADOW,
      alpha: 0.32,
      flip: wright.facing === -1,
      motionless: draw.motionless,
    });
    drawAnimation(draw.context, animation, x, y, elapsed, {
      scale: draw.scale,
      palette: art.palette,
      flip: wright.facing === -1,
      motionless: draw.motionless,
    });

    const centreX = x + 8 * draw.scale;
    drawTask(draw, wright, centreX, y);

    const label = wright.name.length > 18 ? `${wright.name.slice(0, 17)}…` : wright.name;
    plates.push({
      label,
      x: centreX,
      y: y + height * draw.scale,
      /* Close enough for an overlap test without measuring every frame. */
      halfWidth: (label.length * Math.max(11, 4 * draw.scale) * 0.62) / 2,
    });
  }

  /*
   * Plates last, and all together, so a name is never drawn underneath the
   * next wright along and no two land on top of each other.
   */
  const lineHeight = Math.max(11, 4 * draw.scale) + draw.scale * 3;
  for (const plate of spreadPlates(plates, lineHeight)) {
    drawPlate(draw, plate.label, plate.x, plate.y);
  }
}
