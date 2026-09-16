/**
 * Display options for the game, kept per browser.
 *
 * These are not preferences in the ordinary product sense; every one of them
 * exists because a game that ignores it is unplayable for somebody:
 *
 *   safeZone   a TV cuts 3-10% off every edge, so a HUD pinned to the corner
 *              is a HUD that person never sees. Adjustable, because how much
 *              is cut varies by set and nobody can detect it from script.
 *   uiScale    the same layout is viewed from a phone at arm's length and a
 *              4K display across a room. One pixel size cannot serve both.
 *   motion     parallax, shake and particle drift trigger motion sickness.
 *   colour     roughly 8% of men cannot separate the red and green that games
 *              lean on. Every state carries an icon and a label as well, but
 *              the palette should not fight them either.
 *
 * Stored locally rather than on the account, deliberately: which display you
 * are sitting at is a property of the browser, not of who you are. Sign in on
 * the TV and the phone and each keeps its own.
 */

export type MotionSetting = "system" | "full" | "reduced";
export type ColourSetting = "default" | "deuteranopia" | "protanopia" | "tritanopia";

export interface GameOptions {
  /** Percent of each edge treated as unsafe. 0 for a monitor, 5+ for a TV. */
  safeZone: number;
  /** Percent. 100 is the reference design. */
  uiScale: number;
  motion: MotionSetting;
  colour: ColourSetting;
}

export const DEFAULT_OPTIONS: GameOptions = {
  /*
   * Conservative by default. A 5% inset on a monitor costs a little room; a
   * 0% default on a television costs the player their health bar, and only one
   * of those two mistakes is recoverable by someone who cannot see the menu
   * they would need to fix it in.
   */
  safeZone: 5,
  uiScale: 100,
  motion: "system",
  colour: "default",
};

export const SAFE_ZONE_RANGE = { min: 0, max: 10 } as const;
export const UI_SCALE_RANGE = { min: 50, max: 200 } as const;

const MOTION_VALUES: MotionSetting[] = ["system", "full", "reduced"];
const COLOUR_VALUES: ColourSetting[] = ["default", "deuteranopia", "protanopia", "tritanopia"];

const STORAGE_KEY = "shell-online-keep-options";

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Brings anything at all into the shape the renderer can trust.
 *
 * Separate from the storage read so it can be tested without a DOM, and so a
 * value that arrives from the service later goes through the same gate as one
 * that came out of localStorage.
 */
export function normaliseOptions(input: unknown): GameOptions {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Partial<GameOptions>;
  return {
    safeZone: clampNumber(raw.safeZone, DEFAULT_OPTIONS.safeZone, SAFE_ZONE_RANGE.min, SAFE_ZONE_RANGE.max),
    uiScale: clampNumber(raw.uiScale, DEFAULT_OPTIONS.uiScale, UI_SCALE_RANGE.min, UI_SCALE_RANGE.max),
    motion: oneOf(raw.motion, MOTION_VALUES, DEFAULT_OPTIONS.motion),
    colour: oneOf(raw.colour, COLOUR_VALUES, DEFAULT_OPTIONS.colour),
  };
}

export function readOptions(): GameOptions {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return normaliseOptions(stored ? JSON.parse(stored) : null);
  } catch {
    /* Private window, blocked storage, or something that is not JSON. */
    return { ...DEFAULT_OPTIONS };
  }
}

export function writeOptions(options: GameOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normaliseOptions(options)));
  } catch {
    /* The choice is lost on reload, which is survivable; failing is not. */
  }
}

/**
 * Whether animation should be held back, resolving "system" against the OS.
 *
 * Taken as an argument rather than read here so the decision stays pure: the
 * caller owns the media query and can re-run this when it changes.
 */
export function motionReduced(options: GameOptions, systemPrefersReduced: boolean): boolean {
  if (options.motion === "reduced") return true;
  if (options.motion === "full") return false;
  return systemPrefersReduced;
}

/**
 * The CSS custom properties the game's stylesheet reads.
 *
 * Returned as a plain record so the caller can apply it to whichever element
 * scopes the game, and so a test can assert on the values without a browser.
 */
export function optionsToStyle(
  options: GameOptions,
  systemPrefersReduced: boolean,
): Record<string, string> {
  return {
    "--keep-safe": `${options.safeZone}%`,
    "--keep-scale": String(options.uiScale / 100),
    "--keep-motion": motionReduced(options, systemPrefersReduced) ? "0" : "1",
  };
}
