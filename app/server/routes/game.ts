import type { GameProfile } from "../lib/types";

/**
 * The saved game.
 *
 * Two endpoints and no cleverness: read the profile, write the profile. The
 * game is a skin over a session list, not a competitive one, and there is
 * nothing here worth defending against its own owner — everything the profile
 * holds is cosmetic or is a preference.
 *
 * What *is* defended against is nonsense. A body arriving from a browser can
 * say anything at all, and a profile that stored it verbatim would be a
 * profile that could be handed back as something the game cannot draw. So
 * every field is narrowed here, on the way in, exactly as the client narrows
 * what it reads out of storage.
 */

/** The five classes, matching the harnesses in src/lib/session-kinds.ts. */
const CLASSES = ["claude-code", "codex", "hermes", "openclaw", "terminal"];

/** A bound on how many skins one account can be said to own. */
const MAX_OWNED = 200;
/** A bound on the spend, so a bad number cannot make the purse meaningless. */
const MAX_SPENT = 1_000_000_000;

export function emptyProfile(uid: string, now: number): GameProfile {
  return {
    uid,
    characterClass: "",
    skinId: "",
    liveryId: "",
    owned: [],
    spent: 0,
    gathering: false,
    tokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function text(value: unknown, limit = 64): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function count(value: unknown, limit: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(limit, Math.max(0, Math.floor(numeric)));
}

/**
 * A profile from whatever the browser sent.
 *
 * `previous` supplies the fields a save is not allowed to set for itself. The
 * token count is the important one: it is what the elixir vial shows, it is
 * the one figure in the game that corresponds to real money, and it is written
 * by the agent's report rather than by the browser. A client that could set it
 * could tell somebody they had spent nothing.
 */
export function readProfile(
  uid: string,
  body: Record<string, unknown>,
  previous: GameProfile | null,
  now: number,
): GameProfile {
  const before = previous ?? emptyProfile(uid, now);
  const characterClass = text(body.character_class, 32);
  const owned = Array.isArray(body.owned)
    ? body.owned.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_OWNED)
    : before.owned;

  return {
    uid,
    characterClass: CLASSES.includes(characterClass) ? characterClass : before.characterClass,
    skinId: text(body.skin_id, 32),
    liveryId: text(body.livery_id, 32),
    owned,
    spent: count(body.spent, MAX_SPENT),
    gathering: body.gathering === true,
    /* Not the browser's to set. See above. */
    tokens: before.tokens,
    createdAt: before.createdAt,
    updatedAt: now,
  };
}

/** The shape the client reads. Snake case, like the rest of this API. */
export function profileForApi(profile: GameProfile) {
  return {
    character_class: profile.characterClass,
    skin_id: profile.skinId,
    livery_id: profile.liveryId,
    owned: profile.owned,
    spent: profile.spent,
    gathering: profile.gathering,
    tokens: profile.tokens,
    updated_at: profile.updatedAt,
  };
}
