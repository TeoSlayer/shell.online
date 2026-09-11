/**
 * Whether to believe what the service says about the team's audit key.
 *
 * A browser makes the team's key when the service reports there is none. That
 * makes "there is none" worth checking: a service that said it to a browser
 * which had already used a team key could have that browser generate a fresh
 * key and seal it to whatever public keys the service listed as the team's
 * members, including one of its own. So each browser remembers the key it has
 * used for a team, and refuses to make or use a different one.
 *
 * Legitimate replacement is not a thing yet. When it is, it will arrive as a
 * new version with a way to say who replaced it, not as a key that quietly
 * differs from the one this browser knows.
 */

export type TeamKeyVerdict =
  /** No key here and none seen before: this browser makes one. */
  | "create"
  /** The key on offer is the one this browser knows. */
  | "use"
  /** A key was used here before and the service now reports none. */
  | "refuse-missing"
  /** The key on offer is not the one this browser used before. */
  | "refuse-changed";

export function teamKeyVerdict(seen: string | null, offered: string | null): TeamKeyVerdict {
  if (!offered) return seen ? "refuse-missing" : "create";
  if (!seen) return "use";
  return seen === offered ? "use" : "refuse-changed";
}

/** What to tell someone when the key on offer is not the one this browser knows. */
export function teamKeyRefusal(verdict: "refuse-missing" | "refuse-changed"): string {
  return verdict === "refuse-missing"
    ? "Your team has an audit key that this browser has used before, and shell.online is reporting that it has none. Nothing new will be sealed until that is sorted out."
    : "The audit key shell.online reports for your team is not the one this browser has used before. Nothing will be sealed to it. Check with your team before going on.";
}
