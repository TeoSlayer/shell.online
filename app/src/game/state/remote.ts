import { request } from "../../lib/api";
import { normaliseSave, type Save } from "./save";

/**
 * The saved game, on the service.
 *
 * Local storage is where the game reads from and writes to; this is what makes
 * it follow you to another browser. The two are not equal partners: the local
 * copy is authoritative *while playing*, because it is the one that cannot
 * fail mid-purchase, and the service is authoritative *on arrival*, because it
 * is the one that knows about the laptop you used yesterday.
 *
 * Everything here fails soft. A keep that will not open because the service is
 * unreachable is worse than a keep that opens with yesterday's hats.
 */

interface Wire {
  character_class: string;
  skin_id: string;
  livery_id: string;
  owned: string[];
  spent: number;
  gathering: boolean;
  tokens: number;
  updated_at: number;
}

function toSave(wire: Wire): Save {
  return normaliseSave({
    characterClass: wire.character_class,
    skinId: wire.skin_id,
    liveryId: wire.livery_id ?? "",
    owned: wire.owned,
    spent: wire.spent,
    gathering: wire.gathering,
  });
}

export interface RemoteSave {
  save: Save;
  /** Tokens the gathering has spent. Read-only here; the agent reports it. */
  tokens: number;
}

/** Fetches the saved game, or nothing when it cannot be reached. */
export async function loadSave(): Promise<RemoteSave | null> {
  try {
    const body = await request<{ game: Wire }>("/api/game");
    return { save: toSave(body.game), tokens: Number(body.game.tokens) || 0 };
  } catch {
    return null;
  }
}

/**
 * Writes the saved game.
 *
 * Returns whether it landed, so the caller can say "saved here only" rather
 * than claiming something it does not know. The token count is not sent: it is
 * the one figure that stands for real money, and it is written by what the
 * agent reports rather than by whatever a browser asserts.
 */
export async function storeSave(save: Save): Promise<boolean> {
  try {
    await request<{ game: Wire }>("/api/game", {
      method: "PUT",
      body: JSON.stringify({
        character_class: save.characterClass,
        skin_id: save.skinId,
        owned: save.owned,
        spent: save.spent,
        gathering: save.gathering,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of two saves to keep when they differ.
 *
 * The one that has got further, measured by what cannot go backwards: a class
 * once chosen, skins once bought, marks once spent. Taking the newest instead
 * would let a browser that had never been played wipe a keep, and "most
 * recently written" is the wrong question when one of the writers is a tab
 * somebody opened and abandoned.
 */
export function reconcile(local: Save, remote: Save): Save {
  const ownedBoth = [...new Set([...local.owned, ...remote.owned])];
  return {
    characterClass: local.characterClass || remote.characterClass,
    /* Whatever this browser was last wearing, if it is something owned. */
    skinId: ownedBoth.includes(local.skinId) ? local.skinId : remote.skinId,
    liveryId: ownedBoth.includes(local.liveryId) ? local.liveryId : remote.liveryId,
    owned: ownedBoth,
    /* The larger spend: hats already bought cannot become unbought. */
    spent: Math.max(local.spent, remote.spent),
    gathering: local.gathering || remote.gathering,
    version: local.version,
  };
}
