// Owner identity palette — 128 stable, deterministic colours for the workshop
// preview. Pure and dependency-free (HSL -> hex, no provider, no random).
//
// The colour is an ACCENT (forest ground tint / drone accent). It is never the
// sole carrier of meaning: every owner also has a short unique mark ('01'..
// '128') and a name in the legend, so identity survives without colour.
//
// Design goals (task): 128 unique colours; stable by owner index across owner
// counts and reordering; balanced medium light/saturation for a dark forest
// ground and drone accents; deterministic; and every colour keeps a non-text
// contrast of >= 3 against the dark #203a30 label backplate.
//
// We do NOT claim 128 perceptually distinguishable colours — the mark is the
// reliable disambiguator.

export const OWNER_PALETTE_SIZE = 128;

const BACKPLATE = { r: 0x20, g: 0x3a, b: 0x30 }; // #203a30
const CONTRAST_FLOOR = 3;   // WCAG non-text (accent) contrast minimum
const MAX_LIGHT = 0.82;     // cap when raising lightness to meet the floor
// Golden angle: each new owner's hue is as far as possible from the previous
// ones, so any stable prefix (few owners) is well-spread around the wheel.
const GOLDEN_ANGLE = 137.50776405;

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

// HSL (h in degrees, s/l in [0,1]) -> 8-bit { r, g, b }.
function hslToRgb(h, s, l) {
  const sC = clamp01(s);
  const lC = clamp01(l);
  const c = (1 - Math.abs(2 * lC - 1)) * sC;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r, g, b;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lC - c / 2;
  const to255 = (v) => Math.round((v + m) * 255);
  return { r: to255(r), g: to255(g), b: to255(b) };
}

function channelLin(v8) {
  const v = v8 / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relLuminance({ r, g, b }) {
  return 0.2126 * channelLin(r) + 0.7152 * channelLin(g) + 0.0722 * channelLin(b);
}

// WCAG contrast ratio between two 8-bit colours.
function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHex({ r, g, b }) {
  const h = (v) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function buildPalette() {
  const entries = [];
  for (let index = 0; index < OWNER_PALETTE_SIZE; index += 1) {
    // Stable hue by index via the golden angle; medium saturation/lightness
    // bands by index. The fixed prefix is identical regardless of owner count
    // or ordering, and any small prefix is well-spread, not hue-clustered.
    const hue = (index * GOLDEN_ANGLE) % 360;
    const sat = 0.56 + (index % 3) * 0.07;                   // 0.56 / 0.63 / 0.70
    let light = 0.58 + (Math.floor(index / 3) % 4) * 0.045;  // 0.58 / 0.625 / 0.67 / 0.715
    let rgb = hslToRgb(hue, sat, light);
    // Guarantee the non-text contrast floor against the dark backplate.
    let guard = 0;
    while (contrastRatio(rgb, BACKPLATE) < CONTRAST_FLOOR && light < MAX_LIGHT && guard < 60) {
      light += 0.02;
      rgb = hslToRgb(hue, sat, light);
      guard += 1;
    }
    entries.push(Object.freeze({
      index,
      color: rgbToHex(rgb),
      mark: String(index + 1).padStart(2, '0'),
    }));
  }
  return Object.freeze(entries);
}

export const OWNER_PALETTE = buildPalette();

/**
 * Stable identity for an owner index. Valid only for integers 0..127; anything
 * else (out of range, non-integer, non-number) returns null. Returns the same
 * frozen entry every time — it is never recomputed, so identity is stable
 * across owner counts and reordering.
 */
export function ownerIdentity(index) {
  if (!Number.isInteger(index) || index < 0 || index >= OWNER_PALETTE_SIZE) return null;
  return OWNER_PALETTE[index];
}
