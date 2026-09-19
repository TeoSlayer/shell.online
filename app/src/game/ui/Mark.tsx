/**
 * The marks the interface uses beside a label.
 *
 * Drawn icons from the medieval pack rather than typographic glyphs. The glyphs
 * were doing the job badly: ⚒ and ⧗ and ❯ are whatever the reader's font
 * happens to have for them, they sit on the baseline at sizes nobody chose, and
 * three of them rendered as boxes on at least one machine this was looked at
 * on. An icon is the same picture everywhere.
 *
 * Never on its own. Every one of these sits beside a word, because a picture
 * nobody has been taught is decoration, and the word is the thing that actually
 * says what the row is.
 */

/** What each mark is for. One name per thing, not one per icon. */
const MARKS = {
  work: "lance",
  company: "shield",
  machine: "tower",
  running: "torch",
  elapsed: "map",
  condition: "goblet",
  finished: "castle",
  made: "wagon",
} as const;

export type MarkName = keyof typeof MARKS;

export function Mark({ name }: { name: MarkName }) {
  return (
    <img className="keep-mark" src={`/game/kingdom/${MARKS[name]}.svg`} alt="" aria-hidden="true" />
  );
}
