import { decodeSprite, frameAt, frameOffset, paletteFor, type Animation, type Sprite } from "../assets/sprite";
import { SHADOW, type Palette } from "../assets/palette";

/**
 * Decoded sprites, kept for as long as the sprite itself is alive.
 *
 * Decoding is cheap but not free, and a field of forty actors redrawing thirty
 * times a second would do it twelve hundred times a second for pictures that
 * never change. So each sprite is turned into a canvas once per palette it is
 * asked for, and after that drawing is a blit.
 *
 * A WeakMap on the sprite, so an atlas that stops being referenced -- a skin
 * nobody has equipped since -- is collectable rather than pinned for the life
 * of the page.
 */
const cache = new WeakMap<Sprite, Map<Palette, HTMLCanvasElement>>();

/** The sprite as a canvas, decoded on first use and reused afterwards. */
export function spriteCanvas(sprite: Sprite, override?: Palette): HTMLCanvasElement {
  const palette = paletteFor(sprite, override);
  let byPalette = cache.get(sprite);
  if (!byPalette) {
    byPalette = new Map();
    cache.set(sprite, byPalette);
  }
  const existing = byPalette.get(palette);
  if (existing) return existing;

  const canvas = document.createElement("canvas");
  canvas.width = sprite.w;
  canvas.height = sprite.h;
  const context = canvas.getContext("2d");
  if (context) {
    const image = context.createImageData(sprite.w, sprite.h);
    image.data.set(decodeSprite(sprite, palette));
    context.putImageData(image, 0, 0);
  }
  byPalette.set(palette, canvas);
  return canvas;
}

export interface DrawOptions {
  /** Whole-number magnification. See pixelScale in loop.ts for why. */
  scale: number;
  palette?: Palette;
  /** Draw mirrored, so one sprite serves both directions of travel. */
  flip?: boolean;
  alpha?: number;
}

/**
 * Blits a sprite with its pixels kept square.
 *
 * `x` and `y` are rounded because half a pixel of offset is what turns a hard
 * edge into a soft one -- the single most effective way to make pixel art look
 * like a mistake.
 */
export function drawSprite(
  context: CanvasRenderingContext2D,
  sprite: Sprite,
  x: number,
  y: number,
  options: DrawOptions,
): void {
  const { scale, palette, flip = false, alpha = 1 } = options;
  const canvas = spriteCanvas(sprite, palette);
  const width = sprite.w * scale;
  const height = sprite.h * scale;
  const left = Math.round(x);
  const top = Math.round(y);

  context.save();
  context.imageSmoothingEnabled = false;
  if (alpha !== 1) context.globalAlpha = alpha;
  if (flip) {
    context.translate(left + width, top);
    context.scale(-1, 1);
    context.drawImage(canvas, 0, 0, width, height);
  } else {
    context.drawImage(canvas, left, top, width, height);
  }
  context.restore();
}

/**
 * The same sprite as a flat dark shape, offset, under the thing itself.
 *
 * This is the cheapest large improvement available to a view from above. A
 * building drawn straight onto the grass reads as a sticker; the same building
 * with a shadow under it reads as standing on the ground, and the difference
 * costs one extra blit of artwork that already exists.
 *
 * The offset is down and to the right for everything, so one light source is
 * implied across the whole map. Shadows that disagree about where the sun is
 * look worse than no shadows at all.
 */
export function drawShadow(
  context: CanvasRenderingContext2D,
  sprite: Sprite,
  x: number,
  y: number,
  scale: number,
  spread = 2,
): void {
  drawSprite(context, sprite, x + spread * scale, y + spread * scale, {
    scale,
    palette: SHADOW,
    alpha: 0.32,
  });
}

/** One frame of an animation, chosen from the time the caller is holding. */
export function drawAnimation(
  context: CanvasRenderingContext2D,
  animation: Animation,
  x: number,
  y: number,
  elapsedMs: number,
  options: DrawOptions & { motionless?: boolean },
): void {
  const { scale, palette, flip = false, alpha = 1, motionless = false } = options;
  const frame = frameAt(animation, elapsedMs, motionless);
  const canvas = spriteCanvas(animation.sprite, palette);
  const frameWidth = animation.sprite.w / animation.frames;
  const source = frameOffset(animation, frame);
  const width = frameWidth * scale;
  const height = animation.sprite.h * scale;
  const left = Math.round(x);
  const top = Math.round(y);

  context.save();
  context.imageSmoothingEnabled = false;
  if (alpha !== 1) context.globalAlpha = alpha;
  if (flip) {
    context.translate(left + width, top);
    context.scale(-1, 1);
    context.drawImage(canvas, source, 0, frameWidth, animation.sprite.h, 0, 0, width, height);
  } else {
    context.drawImage(
      canvas, source, 0, frameWidth, animation.sprite.h,
      left, top, width, height,
    );
  }
  context.restore();
}
