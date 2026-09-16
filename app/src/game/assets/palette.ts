/**
 * Sixteen colours, and why there are only sixteen.
 *
 * The restriction is the style. Hardware from the era this borrows from could
 * hold a handful of colours at once, and the look everyone remembers — flat
 * fills, hard edges, dithering where a gradient would go — is a consequence of
 * that limit rather than a filter applied afterwards. Give an artist an
 * unlimited palette and the result stops reading as 8-bit no matter how few
 * pixels it has.
 *
 * It also buys two practical things:
 *
 *   Skins are free. A sprite stores palette *indices*, not colours, so a skin
 *   is a different sixteen-entry array — about forty bytes — rather than a
 *   second copy of the artwork. Twelve skins in the shop cost twelve arrays.
 *
 *   Colourblind palettes work everywhere at once. Widening the gap between two
 *   hues is an edit to one table, not to every sprite that used them.
 *
 * The world is warm: sandstone, terracotta, timber and amber, lit as if late
 * in the afternoon. The screens set into the stone are amber CRT rather than
 * green, which is both the warmer choice and the more period-accurate one —
 * amber monochrome monitors were the other half of that history, and they let
 * the keep stay a terminal without a cold green cast over everything.
 */

/** Sixteen CSS colours. Index 0 is the darkest; see the slot map below. */
export type Palette = readonly [
  string, string, string, string,
  string, string, string, string,
  string, string, string, string,
  string, string, string, string,
];

/*
 * What each slot is for. Sprites are authored against these meanings, so a
 * palette swap keeps a structure looking like a structure: slot 9 is "the
 * accent, mid tone" in every palette, whatever colour that happens to be.
 *
 *   0-4   shadow through to lit, the body of a thing
 *   5-7   pale, for highlights and parchment
 *   8-11  the accent ramp, dark to brightest
 *   12-14 timber and metal, dark to gold
 *   15    alarm: damage, danger, a thing that has gone wrong
 */
export const SLOT = {
  shadow: 0,
  bodyDark: 1,
  body: 2,
  bodyLit: 3,
  bodyHigh: 4,
  mist: 5,
  pale: 6,
  paper: 7,
  accentDark: 8,
  accent: 9,
  accentLit: 10,
  accentBright: 11,
  timberDark: 12,
  timber: 13,
  gold: 14,
  alarm: 15,
} as const;

/**
 * Sandstone and terracotta: the keep and everything built of it.
 *
 * Five steps of stone rather than three, because detail at this size is
 * shading. A wall with one highlight and one shadow reads as a rectangle; a
 * wall with five steps reads as masonry.
 */
export const STONE: Palette = [
  "#160f0c", "#2b1d16", "#463024", "#6a4a33",
  "#8f6a45", "#b58d5f", "#d9b88a", "#f5e3c0",
  "#5e2a16", "#94441f", "#c46b2a", "#f0a03c",
  "#4a3a1e", "#7d6430", "#e8c65a", "#c0392b",
];

/** Grass, dirt and the worn path between them. */
export const FIELD: Palette = [
  "#141208", "#241f0e", "#343017", "#474620",
  "#5b5c28", "#757334", "#938d48", "#bdb271",
  "#4a3418", "#6b4a22", "#8d652f", "#b0854a",
  "#3a2a14", "#5c4420", "#e8c65a", "#c0392b",
];

/**
 * What the bugs are made of.
 *
 * The one palette that does not belong here. Everything else in the keep is
 * warm; a bug is cold, sickly and slightly luminous, so it reads as something
 * that got in rather than something that lives here. That contrast is doing
 * the same job an outline would, without costing a pixel.
 */
export const GLITCH: Palette = [
  "#04100c", "#0b2019", "#133228", "#1c4838",
  "#266048", "#37805c", "#57a877", "#9fe0b4",
  "#123b4a", "#1a5e6b", "#2a8f92", "#48d6c0",
  "#2b1a3a", "#4a2d5e", "#7b4a9c", "#ff5e7a",
];

export const PALETTES = { stone: STONE, field: FIELD, glitch: GLITCH } as const;
export type PaletteName = keyof typeof PALETTES;

/**
 * A palette with some slots replaced. This is the whole of what a skin is.
 *
 * Kept as a function rather than as pre-built tables so a shop skin is stored
 * as the handful of slots it changes, which is what makes one cheap enough to
 * hand out on a level-up.
 */
export function reskin(base: Palette, changes: Partial<Record<number, string>>): Palette {
  return base.map((colour, slot) => changes[slot] ?? colour) as unknown as Palette;
}

/**
 * Every slot the same colour, which turns any sprite into its own silhouette.
 *
 * This is how things get shadows. Drawing the sprite again in flat dark, a few
 * pixels down and to the right and at low opacity, costs one more blit and no
 * new artwork — and it is the single biggest thing that stops a building
 * looking like a sticker laid on the grass. Objects without shadows read as
 * floating no matter how well they are drawn.
 */
export function silhouette(colour: string): Palette {
  return Array.from({ length: 16 }, () => colour) as unknown as Palette;
}

/**
 * The one shadow palette, shared.
 *
 * A module constant rather than a fresh array each call, because the renderer
 * caches decoded sprites by palette identity: a new array every frame would
 * decode every sprite on screen every frame and defeat the cache entirely.
 */
export const SHADOW = silhouette("#100a06");

/**
 * How far apart two colours are, roughly as an eye sees it.
 *
 * Used by the palette tests to hold the colourblind variants to their promise:
 * if alarm and accent are not far enough apart in a palette meant to separate
 * them, the palette is not doing its job and the test says so. Weighted
 * towards green because that is where human vision has the most resolution.
 */
export function contrast(a: string, b: string): number {
  const parse = (hex: string) => {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return Math.sqrt(2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2);
}
