import { TRANSPARENT, type Animation, type Sprite } from "./sprite";

/**
 * Building animation strips out of single frames.
 *
 * An animation is stored as its frames laid side by side in one sprite, which
 * is what lets the renderer blit a sub-rectangle instead of juggling a list of
 * images. Typing those rows out by hand means counting to forty-eight, sixteen
 * times, without slipping -- and a single miscounted row shifts every pixel
 * after it.
 *
 * So frames are authored one at a time, at their own width, and joined here.
 * The helpers below are the only reason the artwork in this directory is worth
 * trusting.
 */

/** One frame: rows of palette characters, all the same length. */
export type Frame = string[];

/** Lays frames side by side into the strip an Animation expects. */
export function strip(frames: Frame[], palette: Sprite["palette"]): Sprite {
  const height = frames[0]?.length ?? 0;
  const width = frames[0]?.[0]?.length ?? 0;
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(frames.map((frame) => frame[y] ?? "".padEnd(width, TRANSPARENT)).join(""));
  }
  return { w: width * frames.length, h: height, palette, rows };
}

export function animation(
  frames: Frame[],
  palette: Sprite["palette"],
  fps: number,
): Animation {
  return { sprite: strip(frames, palette), frames: frames.length, fps };
}

/**
 * The same frame moved down by a row or two.
 *
 * Most of the idle animation in this game is a one-pixel bob. Drawing it twice
 * would be two chances to make a mistake for a picture that is the same.
 */
export function bob(frame: Frame, by = 1): Frame {
  const width = frame[0]?.length ?? 0;
  const blank = TRANSPARENT.repeat(width);
  return [...Array.from({ length: by }, () => blank), ...frame.slice(0, frame.length - by)];
}

/** A frame with one palette slot swapped for another, for a flash on damage. */
export function recolour(frame: Frame, from: string, to: string): Frame {
  return frame.map((row) => row.split(from).join(to));
}

/** A single frame as a still sprite. */
export function still(frame: Frame, palette: Sprite["palette"]): Sprite {
  return {
    w: frame[0]?.length ?? 0,
    h: frame.length,
    palette,
    rows: [...frame],
  };
}
