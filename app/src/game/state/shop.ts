import { reskin, STONE, type Palette } from "../assets/palette";

/**
 * What marks can be spent on.
 *
 * Everything here is cosmetic. Nothing in the shop makes a wright hit harder,
 * a wall hold longer or experience arrive faster, and that is a deliberate
 * line rather than an oversight: the moment a purchase changes the numbers,
 * the game stops being a read-out of work that happened and starts being
 * something you could play wrong. There is no way to play this wrong.
 *
 * The fortification of the keep is *not* sold. It is earned by levelling,
 * because the base growing is the reward for the work, and selling it would
 * let somebody buy the thing the work is supposed to have bought them.
 */

export interface Skin {
  id: string;
  name: string;
  /** One line, in the world's voice, so the shop reads as a place. */
  note: string;
  cost: number;
  /** Which class it dresses, or "any" for the whole garrison. */
  fits: string | "any";
  /** The slots it changes. A skin is a handful of colours, nothing more. */
  changes: Partial<Record<number, string>>;
}

/**
 * The catalogue.
 *
 * Costs rise with how loud the skin is, which is the only balancing this
 * needs: the quiet ones are affordable early, and the one that makes your
 * whole garrison gold is a thing you save for.
 */
export const SKINS: Skin[] = [
  {
    id: "ash",
    name: "Ashen",
    note: "Whatever it was before, it has been through a fire since.",
    cost: 40,
    fits: "any",
    changes: { 8: "#2b2b2b", 9: "#4a4a4a", 10: "#6e6e6e", 11: "#9a9a9a" },
  },
  {
    id: "moss",
    name: "Moss",
    note: "Issued to whoever was last through the gate.",
    cost: 40,
    fits: "any",
    changes: { 8: "#25401c", 9: "#3d6b2c", 10: "#5c963f", 11: "#8bc45c" },
  },
  {
    id: "wine",
    name: "Winefast",
    note: "Dyed properly, once, by somebody who was owed a favour.",
    cost: 80,
    fits: "any",
    changes: { 8: "#3d1226", 9: "#6b2040", 10: "#9c3560", 11: "#c96a92" },
  },
  {
    id: "frost",
    name: "Frostbound",
    note: "Cold colours on a warm march. It does not help.",
    cost: 80,
    fits: "codex",
    changes: { 8: "#123244", 9: "#1d5570", 10: "#2f86a8", 11: "#63c2dd" },
  },
  {
    id: "forge",
    name: "Forgelit",
    note: "The Artificers had these made. Nobody asked for them.",
    cost: 120,
    fits: "claude-code",
    changes: { 8: "#5e1c08", 9: "#953210", 10: "#d15a1c", 11: "#ffa03c" },
  },
  {
    id: "gilt",
    name: "Gilt",
    note: "The Castellan's own colours. Wear them and mean it.",
    cost: 260,
    fits: "any",
    changes: { 8: "#5a4208", 9: "#8f6a12", 10: "#c79a24", 11: "#f2d357" },
  },
];

export function skinById(id: string): Skin | undefined {
  return SKINS.find((skin) => skin.id === id);
}

/** Whether a skin can be worn by a given class. */
export function fitsClass(skin: Skin, kind: string): boolean {
  return skin.fits === "any" || skin.fits === kind;
}

export interface Purse {
  /** Marks earned, less marks spent. */
  marks: number;
  owned: string[];
}

export type Refusal = "unknown" | "owned" | "poor";

export type PurchaseResult = { ok: true; purse: Purse } | { ok: false; reason: Refusal };

/**
 * Buying something.
 *
 * Pure, and returns a new purse rather than changing the old one, so the
 * caller can show the result of a purchase before committing to it and the
 * service can run exactly the same function to check the client was telling
 * the truth.
 *
 * Every refusal has a reason the interface can put into words. "Nothing
 * happened" is the worst possible answer to a button press.
 */
export function buy(purse: Purse, skinId: string): PurchaseResult {
  const skin = skinById(skinId);
  if (!skin) return { ok: false, reason: "unknown" };
  if (purse.owned.includes(skinId)) return { ok: false, reason: "owned" };
  if (purse.marks < skin.cost) return { ok: false, reason: "poor" };
  return {
    ok: true,
    purse: { marks: purse.marks - skin.cost, owned: [...purse.owned, skinId] },
  };
}

export const REFUSALS: Record<Refusal, string> = {
  unknown: "The pedlar has never heard of it.",
  owned: "You have one already.",
  poor: "Not enough marks.",
};

/**
 * The palette a wright wears.
 *
 * A skin is the same kind of thing as a class: a handful of slots swapped on
 * the one figure. That is why the renderer never has to know which of the two
 * it has been handed.
 */
export function paletteFor(base: Palette, skinId?: string): Palette {
  const skin = skinId ? skinById(skinId) : undefined;
  return skin ? reskin(base, skin.changes) : base;
}

/** A palette for a preview swatch, without needing the class it belongs to. */
export function previewPalette(skinId: string): Palette {
  return paletteFor(STONE, skinId);
}
