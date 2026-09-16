import { PALETTES, type Palette, type PaletteName } from "./palette";

/**
 * Pixel art as text.
 *
 * A sprite is rows of characters, one per pixel: '.' is transparent and the
 * hex digits 0-f are slots in a sixteen-colour palette. A 32x32 sprite is
 * about a kilobyte of source that gzips to a couple of hundred bytes.
 *
 * Why not PNGs. This repository has no pipeline for binary assets, a build
 * that checks what ends up in the bundle, and a review culture that reads
 * diffs. A folder of images would be none of those things: a change to a
 * watchtower would show up in review as "binary file differs", the atlas would
 * need fetching and caching and cache-busting, and a skin would mean a second
 * copy of every image rather than a different palette. Written this way, a
 * sprite is reviewable, the whole atlas travels inside the game's chunk, and
 * recolouring is free.
 *
 * The cost is honest: authoring by hand is slower than drawing, and nothing
 * here is going to render a photograph. For chunky 16- and 32-pixel artwork
 * with a strict palette, that is not the constraint that binds.
 */
export interface Sprite {
  w: number;
  h: number;
  palette: PaletteName;
  /** One string per row, `w` characters each. '.' is transparent. */
  rows: string[];
}

/** A sprite drawn as several frames laid out left to right in one row set. */
export interface Animation {
  sprite: Sprite;
  /** How many frames sit side by side inside `sprite`. */
  frames: number;
  /** Frames per second. Kept low on purpose; this is not a cartoon. */
  fps: number;
}

export const TRANSPARENT = ".";

/** Turns one authored character into a palette slot, or -1 for transparent. */
export function slotOf(character: string): number {
  if (character === TRANSPARENT) return -1;
  const slot = Number.parseInt(character, 16);
  return Number.isNaN(slot) ? -1 : slot;
}

/**
 * Everything wrong with a sprite, as sentences.
 *
 * Authoring by hand means miscounting a row, and a sprite one character short
 * is a column of pixels silently shifted for the rest of the image -- the kind
 * of thing that is obvious in a test and baffling on screen. Returned as a
 * list rather than thrown so one test can report every mistake in the atlas at
 * once instead of stopping at the first.
 */
export function spriteProblems(name: string, sprite: Sprite): string[] {
  const problems: string[] = [];
  if (sprite.w <= 0 || sprite.h <= 0) {
    problems.push(`${name}: size ${sprite.w}x${sprite.h} is not a picture`);
    return problems;
  }
  if (sprite.rows.length !== sprite.h) {
    problems.push(`${name}: says it is ${sprite.h} rows tall but has ${sprite.rows.length}`);
  }
  sprite.rows.forEach((row, index) => {
    if (row.length !== sprite.w) {
      problems.push(`${name}: row ${index} is ${row.length} wide, expected ${sprite.w}`);
    }
    for (const character of row) {
      if (character === TRANSPARENT) continue;
      const slot = slotOf(character);
      if (slot < 0 || slot > 15) {
        problems.push(`${name}: row ${index} has '${character}', which is not a palette slot`);
        break;
      }
    }
  });
  return problems;
}

/**
 * A sprite as raw RGBA bytes.
 *
 * Kept separate from anything that touches a canvas so the decoder is testable
 * in the node environment the rest of this project's tests run in.
 */
export function decodeSprite(sprite: Sprite, palette: Palette): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(sprite.w * sprite.h * 4);
  for (let y = 0; y < sprite.h; y += 1) {
    const row = sprite.rows[y] ?? "";
    for (let x = 0; x < sprite.w; x += 1) {
      const slot = slotOf(row[x] ?? TRANSPARENT);
      const at = (y * sprite.w + x) * 4;
      if (slot < 0) continue;
      const hex = palette[slot] ?? "#000000";
      const value = Number.parseInt(hex.slice(1), 16);
      pixels[at] = (value >> 16) & 255;
      pixels[at + 1] = (value >> 8) & 255;
      pixels[at + 2] = value & 255;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

/** The palette a sprite asks for, unless something is overriding it for a skin. */
export function paletteFor(sprite: Sprite, override?: Palette): Palette {
  return override ?? PALETTES[sprite.palette];
}

/**
 * Which frame of an animation to show at a given moment.
 *
 * Takes the time rather than reading a clock, so a paused game simply stops
 * passing time and every animation in it holds still without any of them
 * needing to know that pausing exists.
 */
export function frameAt(animation: Animation, elapsedMs: number, motionless = false): number {
  if (motionless || animation.frames <= 1) return 0;
  const index = Math.floor((elapsedMs / 1000) * animation.fps);
  return ((index % animation.frames) + animation.frames) % animation.frames;
}

/** The pixel column an animation's frame starts at. */
export function frameOffset(animation: Animation, frame: number): number {
  return frame * (animation.sprite.w / animation.frames);
}
