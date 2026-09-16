/**
 * What a session looks like it is doing, read from what it is called.
 *
 * This is the one piece of the game the server also needs, which is why it
 * lives on its own with no imports at all. The field draws a wright walking to
 * the garrison its work belongs to, and the service counts the same sessions
 * to work out what a level is worth; a second copy of these patterns would
 * drift, and the map would start disagreeing with the ladder about what a
 * session was.
 *
 * It costs the corporate view nothing: this module is reached only from the
 * game chunk and from the service, and the bundle check would fail if that
 * stopped being true.
 */

export type Work = "bug" | "feature" | "idle";

/**
 * Read from the name and the command, because that is all there is without
 * asking the machine — and the conventions people already use are strong. A
 * branch called `fix/...`, a session named `fix: audit seal`, a commit style
 * of `feat:`; these are not guesses so much as an existing vocabulary.
 *
 * Anything unrecognised is neither, and shows as a wright going about the yard
 * rather than being forced into a category it does not belong in. Pretending
 * to know is worse than showing that you do not.
 */
const MENDING = /\b(fix|fixes|fixing|bug|bugs|hotfix|patch|repair|revert|debug|issue)\b/i;
const MAKING = /\b(feat|feature|add|adds|adding|build|implement|create|new|refactor|migrate)\b/i;

export function workFor(text: string): Work {
  /*
   * Mending is checked first. "fix the new importer" is a fix; reading it as a
   * feature because it contains "new" would be exactly backwards, and fixes
   * are the more specific claim.
   */
  if (MENDING.test(text)) return "bug";
  if (MAKING.test(text)) return "feature";
  return "idle";
}
