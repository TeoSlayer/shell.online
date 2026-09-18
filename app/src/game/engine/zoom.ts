/**
 * The camera's limits, and the steps it moves in.
 *
 * Arithmetic only, with no Pixi in it, because every one of these numbers used
 * to be worked out inline in the renderer against a screen size that was wrong
 * -- and a zoom limit computed from the wrong screen is a map somebody cannot
 * get out of, which is exactly what a phone reported.
 *
 * The screen here is the canvas, not the window. On a phone those are not the
 * same thing and the difference is the browser's own furniture.
 */

/** How far in the art may be enlarged before it is visibly enlarged. */
export const CLOSEST = 2;

/** One press of a zoom control. A little under half an octave. */
export const ZOOM_STEP = 1.45;

/**
 * The span of country the game tries to open on, in world pixels.
 *
 * About twenty-six tiles across. Wide enough to show a camp and the road out
 * of it, close enough that the people in it are people rather than specks.
 */
const OPENING_ACROSS = 1700;
const OPENING_DOWN = 1100;

/**
 * And the closest the opening view is ever wound in.
 *
 * A phone is narrow enough that fitting the opening span would put a hero at
 * seven pixels tall. Better to open on less country at a size somebody can
 * read, and let them pull back with the controls, than to open on a diagram.
 */
const OPENING_FLOOR = 0.45;

export interface ZoomBounds {
  min: number;
  max: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The zoom at which the whole country is on screen.
 *
 * Worked out from the map rather than picked, so making the Marches bigger
 * cannot quietly leave a corner of them unreachable.
 */
export function fitZoom(
  screenWidth: number,
  screenHeight: number,
  worldWidth: number,
  worldHeight: number,
): number {
  if (screenWidth <= 0 || screenHeight <= 0) return 0;
  return Math.min(screenWidth / worldWidth, screenHeight / worldHeight);
}

/**
 * How far out and in the camera may go on this canvas.
 *
 * The floor is whatever shows the whole country. It is re-read whenever the
 * canvas changes size, because a phone turned on its side is a different
 * screen and a limit left over from the last one is a limit that is wrong.
 */
export function zoomBounds(
  screenWidth: number,
  screenHeight: number,
  worldWidth: number,
  worldHeight: number,
): ZoomBounds {
  const min = fitZoom(screenWidth, screenHeight, worldWidth, worldHeight);
  /* A degenerate canvas must not produce min > max and freeze the camera. */
  return { min: Math.min(min, CLOSEST), max: CLOSEST };
}

/** One press of a zoom control, kept inside the limits. */
export function stepZoom(current: number, factor: number, bounds: ZoomBounds): number {
  if (!Number.isFinite(current) || current <= 0) return bounds.min;
  return clamp(current * factor, bounds.min, bounds.max);
}

/** Whether a control has anywhere left to go, for disabling it honestly. */
export function atLimit(current: number, bounds: ZoomBounds): { out: boolean; in: boolean } {
  /* A hair of tolerance, or a control sticks enabled at the exact limit. */
  const grain = 1.0001;
  return { out: current <= bounds.min * grain, in: current >= bounds.max / grain };
}

/**
 * Where the camera starts: close enough to see people, wide enough to see
 * where they are.
 *
 * It used to be the constant 0.75, which is a reasonable view of a laptop and
 * eight tiles of country on a phone.
 */
export function openingZoom(
  screenWidth: number,
  screenHeight: number,
  bounds: ZoomBounds,
): number {
  const wanted = Math.min(screenWidth / OPENING_ACROSS, screenHeight / OPENING_DOWN);
  return clamp(Math.max(wanted, OPENING_FLOOR), bounds.min, bounds.max);
}

/**
 * How far above a thing the camera sits, so the HUD does not cover it.
 *
 * A share of the screen rather than a fixed 150 pixels: on a short landscape
 * phone that constant lifted the subject clean off the top of the picture.
 */
export function headroom(screenHeight: number): number {
  return clamp(screenHeight * 0.18, 40, 150);
}

/**
 * How far a name board over somebody's head may be enlarged.
 *
 * Boards scale against the zoom, so that a company can be found at the far end
 * of a large map. That is right on a monitor and wrong on a handset: the same
 * rule at a phone's opening zoom put a board more than twice its drawn size
 * across a screen 390 pixels wide, and the map disappeared behind the labels
 * on it.
 *
 * So the ceiling comes from the canvas. A narrow screen gets a low one, which
 * is affordable precisely because a phone is held at arm's length rather than
 * read across a room.
 */
export function plateCeiling(screenWidth: number): number {
  if (screenWidth <= 480) return 1.3;
  if (screenWidth <= 900) return 1.8;
  return 2.6;
}
