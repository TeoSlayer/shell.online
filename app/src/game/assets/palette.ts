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
 * The ramps are the product's own colours from tokens.css, read as materials.
 * That is what stops the keep looking like a generic pixel game with our name
 * on it: the stone is the terminal, the parchment is the page.
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

/** Stone, moss and elixir: the keep itself and the ground it stands on. */
export const KEEP: Palette = [
  "#0d1009", "#1d201b", "#343a2e", "#4e5545",
  "#6f7862", "#8d9382", "#c3c8b4", "#f3f1e9",
  "#2b4a1f", "#4a7a2c", "#7fb03a", "#c8ff4d",
  "#6b4418", "#a8762b", "#e8b44a", "#c2412c",
];

/** The same materials lit by arcane blue, for anything the Arcanist touches. */
export const ARCANE: Palette = [
  "#080a12", "#161a2b", "#252c47", "#394465",
  "#4f5d88", "#7b87ad", "#b4bdd8", "#eef1fb",
  "#1a2a6b", "#2f47b0", "#4267f5", "#8fa6ff",
  "#5a4a7a", "#8b6fb8", "#c9a7f0", "#e0575f",
];

/**
 * Corrupted scanlines: what the bugs are made of.
 *
 * Deliberately the one palette that does not belong to the world. A bug should
 * look like something that got in rather than something that lives here.
 */
export const GLITCH: Palette = [
  "#0a0510", "#1d0f2b", "#331a47", "#4d2a66",
  "#6b3d88", "#9159ad", "#bf86d4", "#f0d9ff",
  "#5c0f4a", "#96197a", "#d426a6", "#ff6fd8",
  "#3a2a0f", "#6b5520", "#b89a3a", "#ff4d4d",
];

export const PALETTES = { keep: KEEP, arcane: ARCANE, glitch: GLITCH } as const;
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
