import { drawAnimation, drawShadow, drawSprite } from "../engine/atlas";
import type { DrawContext } from "../engine/Stage";
import { foeArt } from "../assets/foes";
import { BUILD_SITE } from "../assets/structures";
import { SHADOW, silhouette } from "../assets/palette";
import { TILE } from "../assets/terrain";
import type { Foe, Mark, World } from "../state/world";

/**
 * The Unmade, and the numbers that come off them.
 *
 * Drawn after the wrights so a fault is always in front of whoever is hitting
 * it — you should be able to see the thing being fought.
 */

/**
 * The flash a foe shows when it has just been hit.
 *
 * A module constant, not built per hit: the sprite cache is keyed on palette
 * identity, so a fresh array each frame would re-decode every foe on screen
 * every frame and quietly undo the whole point of the cache.
 */
const FLASH = silhouette("#ffd9e2");

function drawHealth(draw: DrawContext, foe: Foe, x: number, y: number, width: number): void {
  if (foe.hp >= foe.maxHp) return;
  const { context, scale } = draw;
  const height = Math.max(2, scale);
  const top = y - height * 2;

  context.save();
  context.fillStyle = "#160f0c";
  context.fillRect(x, top, width, height);
  context.fillStyle = "#48d6c0";
  context.fillRect(x, top, Math.max(0, (width * foe.hp) / foe.maxHp), height);
  context.restore();
}

/**
 * A number rising off something that was just hit.
 *
 * Floats up and fades over its life. Outlined, like every other piece of text
 * on the field, because it appears over grass, over paving and over a fire.
 */
function drawMark(draw: DrawContext, mark: Mark): void {
  const { context, scale } = draw;
  const progress = 1 - mark.life / mark.maxLife;
  const size = Math.max(12, 5 * scale);
  const x = (mark.x * TILE + TILE / 2) * scale;
  const y = (mark.y * TILE) * scale - progress * 12 * scale;

  context.save();
  /* Holds full strength for the first half, then goes. */
  context.globalAlpha = Math.min(1, (1 - progress) * 2);
  context.font = `bold ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = Math.max(2, scale / 2);
  context.strokeStyle = "#160f0c";
  context.strokeText(mark.text, x, y);
  context.fillStyle = mark.kind === "damage" ? "#ff6fd8" : "#e8c65a";
  context.fillText(mark.text, x, y);
  context.restore();
}

/**
 * The plots being built on, at whichever stage they have reached.
 *
 * Drawn before the wrights rather than after: a builder stands in front of
 * what they are raising, which is the only arrangement that reads as working
 * on it rather than hiding behind it.
 */
export function drawSites(draw: DrawContext, world: World): void {
  for (const site of world.sites) {
    const stage = Math.min(
      BUILD_SITE.length - 1,
      Math.floor((site.progress / site.total) * BUILD_SITE.length),
    );
    const sprite = BUILD_SITE[stage];
    const x = (site.x * TILE + TILE / 2 - sprite.w / 2) * draw.scale;
    const y = (site.y * TILE + TILE - sprite.h) * draw.scale;
    drawShadow(draw.context, sprite, x, y, draw.scale, 2);
    drawSprite(draw.context, sprite, x, y, { scale: draw.scale });
  }
}

export function drawFoes(draw: DrawContext, world: World): void {
  const ordered = [...world.foes].sort((a, b) => a.y - b.y);
  const elapsed = (world.clock / 30) * 1000;

  for (const foe of ordered) {
    const art = foeArt(foe.kind);
    const frameWidth = art.walk.sprite.w / art.walk.frames;
    const x = (foe.x * TILE + TILE / 2) * draw.scale - (frameWidth / 2) * draw.scale;
    const y = (foe.y * TILE + TILE - art.walk.sprite.h) * draw.scale;

    drawAnimation(draw.context, art.walk, x + draw.scale, y + draw.scale, elapsed, {
      scale: draw.scale,
      palette: SHADOW,
      alpha: 0.3,
      flip: foe.facing === -1,
      motionless: draw.motionless,
    });
    drawAnimation(draw.context, art.walk, x, y, elapsed, {
      scale: draw.scale,
      /*
       * White while flinching. Colour alone is never the only signal in this
       * game, and here it is not: the number coming off it says the same thing
       * in figures, and the bar below says it a third time.
       */
      palette: foe.hurt > 0 ? FLASH : undefined,
      flip: foe.facing === -1,
      motionless: draw.motionless,
    });

    drawHealth(draw, foe, x, y, frameWidth * draw.scale);
  }

  for (const mark of world.marks) drawMark(draw, mark);
}
