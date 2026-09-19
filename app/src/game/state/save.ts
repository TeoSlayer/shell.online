/**
 * The saved game.
 *
 * Small on purpose. Everything that can be *derived* is derived — the level
 * from the experience, the fortification from the level, the marks earned from
 * the level — so what is actually stored is only the handful of things that
 * cannot be worked out again: who you chose to be, what you are wearing, what
 * you have bought, and what you have spent.
 *
 * That matters more than it sounds. A save that stores the level as well as
 * the experience has two facts that can disagree, and the day they disagree
 * somebody has to decide which one is true. A save that stores only the
 * experience cannot have that bug.
 */

export interface Save {
  /** Which class the player chose. Empty until they have chosen. */
  characterClass: string;
  /** The skin worn, if any. */
  skinId: string;
  /** What your soldiers wear. Separate from what you wear. */
  liveryId: string;
  /** Skins bought. */
  owned: string[];
  /** Marks spent, so the purse is (earned by level) minus this. */
  spent: number;
  /** Whether the player has agreed to the stat-gathering. */
  gathering: boolean;
  /** Bumped when the shape changes, so an old save can be read or dropped. */
  version: number;
}

export const SAVE_VERSION = 1;

export const NEW_SAVE: Save = {
  characterClass: "",
  skinId: "",
  liveryId: "",
  owned: [],
  spent: 0,
  gathering: false,
  version: SAVE_VERSION,
};

const STORAGE_KEY = "shell-online-keep-save";

const CLASSES = ["claude-code", "codex", "hermes", "openclaw", "terminal"];

/**
 * Brings anything at all into a save the game can run on.
 *
 * Saves arrive from localStorage, from the service, and from an older version
 * of this file. All three can be wrong in different ways, and a game that
 * throws on a malformed save is a game somebody cannot get back into.
 */
export function normaliseSave(input: unknown): Save {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Partial<Save>;
  const owned = Array.isArray(raw.owned)
    ? raw.owned.filter((id): id is string => typeof id === "string").slice(0, 200)
    : [];
  return {
    characterClass: CLASSES.includes(raw.characterClass as string) ? (raw.characterClass as string) : "",
    skinId: typeof raw.skinId === "string" ? raw.skinId : "",
    liveryId: typeof raw.liveryId === "string" ? raw.liveryId : "",
    owned,
    spent: Number.isFinite(raw.spent) ? Math.max(0, Math.floor(raw.spent as number)) : 0,
    gathering: raw.gathering === true,
    version: SAVE_VERSION,
  };
}

export function readSave(): Save {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return normaliseSave(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...NEW_SAVE };
  }
}

export function writeSave(save: Save): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normaliseSave(save)));
  } catch {
    /*
     * A private window cannot store it. The game still runs; it simply starts
     * again next time, which is survivable. Failing here would not be.
     */
  }
}

/** Whether the game has been played before on this account. */
export function hasChosen(save: Save): boolean {
  return save.characterClass !== "";
}

/**
 * The purse, from what has been earned and what has been spent.
 *
 * Derived rather than stored, so it cannot drift from the level that earned
 * it. Clamped at zero because a save that has been edited by hand should make
 * the shop unaffordable, not make it free.
 */
export function marksLeft(earned: number, save: Save): number {
  return Math.max(0, earned - save.spent);
}
