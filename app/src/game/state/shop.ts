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
  /** Which class it dresses, or "any" for anyone. */
  fits: string | "any";
  /**
   * Who wears it: you, or the people who work for you.
   *
   * Two different things, sold side by side. A hero skin dresses your own
   * figure; a retinue colour washes over your soldiers, so that a map with
   * several companies on it reads as several companies rather than as one
   * crowd. Neither touches anybody else's -- you cannot dress a colleague, and
   * a shop that let you would be the only thing in this game that changes what
   * somebody else sees.
   */
  wears: "hero" | "retinue";
  /**
   * The colour the wright is washed in.
   *
   * A skin used to be a sixteen-slot palette swap, because the artwork was
   * palette-indexed text authored in this repository. The artwork is now
   * Kenney's, which is ordinary PNG, so a skin is a tint: one number
   * multiplied over the sprite by the renderer. Simpler, and it survives the
   * artwork being replaced again.
   */
  tint: number;
}

/**
 * The catalogue.
 *
 * Costs rise with how loud the skin is, which is the only balancing this
 * needs: the quiet ones are affordable early, and the one that turns your
 * whole garrison gold is a thing you save for.
 */
export const SKINS: Skin[] = [
  /* ---- what you wear ---- */
  {
    id: "ash",
    name: "Ashen",
    note: "Whatever it was before, it has been through a fire since.",
    cost: 40,
    fits: "any",
    wears: "hero",
    tint: 0x9a9a9a,
  },
  {
    id: "wine",
    name: "Winefast",
    note: "Dyed properly, once, by somebody who was owed a favour.",
    cost: 80,
    fits: "any",
    wears: "hero",
    tint: 0xc96a92,
  },
  {
    id: "frost",
    name: "Frostbound",
    note: "Cold colours on a warm march. It does not help.",
    cost: 80,
    fits: "codex",
    wears: "hero",
    tint: 0x7fd0e8,
  },
  {
    id: "forge",
    name: "Forgelit",
    note: "The Artificers had these made. Nobody asked for them.",
    cost: 120,
    fits: "claude-code",
    wears: "hero",
    tint: 0xff9a3c,
  },
  {
    id: "gilt",
    name: "Gilt",
    note: "The Castellan's own colours. Wear them and mean it.",
    cost: 260,
    fits: "any",
    wears: "hero",
    tint: 0xf2d357,
  },

  /* ---- what your soldiers wear ---- */
  {
    id: "moss",
    name: "Moss livery",
    note: "Issued to whoever was last through the gate.",
    cost: 40,
    fits: "any",
    wears: "retinue",
    tint: 0x76b055,
  },
  {
    id: "slate",
    name: "Slate livery",
    note: "Hard to see at dusk, which is half the point of it.",
    cost: 60,
    fits: "any",
    wears: "retinue",
    tint: 0x8fa3b8,
  },
  {
    id: "ember",
    name: "Ember livery",
    note: "A company you can find across a field, for better or worse.",
    cost: 120,
    fits: "any",
    wears: "retinue",
    tint: 0xe2703a,
  },
  {
    id: "indigo",
    name: "Indigo livery",
    note: "Expensive dye on people who will be in a ditch by Thursday.",
    cost: 200,
    fits: "any",
    wears: "retinue",
    tint: 0x7f7fe0,
  },
];

export function skinById(id: string): Skin | undefined {
  return SKINS.find((skin) => skin.id === id);
}

/** Whether a skin can be worn by a given class. */
export function fitsClass(skin: Skin, kind: string): boolean {
  /*
   * A retinue colour is worn by a company of mixed classes, so it cannot be cut
   * for one of them. Only what the hero wears is ever class-bound.
   */
  if (skin.wears === "retinue") return true;
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

/** The tint a wright wears. White is "as drawn", which is no skin at all. */
export function tintFor(skinId?: string): number {
  return (skinId ? skinById(skinId)?.tint : undefined) ?? 0xffffff;
}

/** The same number as a CSS colour, for the swatch in the shop. */
export function swatchFor(skinId: string): string {
  return `#${tintFor(skinId).toString(16).padStart(6, "0")}`;
}
