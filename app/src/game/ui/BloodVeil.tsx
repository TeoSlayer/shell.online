import { veilOpacity, type Strength } from "../world/kingdom";

/**
 * The kingdom struggling, said without words.
 *
 * Blood at the corners of the picture, heavier the further the garrison is
 * from meeting what is coming for it. It is at the corners because that is
 * where a thing you feel rather than read belongs -- across the middle it
 * would be a filter over the map, and the map is the game.
 *
 * It is never the only thing that says this. The HUD carries the same fact in
 * words and a number, because a wash of red says nothing to somebody who
 * cannot separate it from the grass, nothing in a screenshot, and nothing at
 * all to a screen reader. This is the glance; the words are the answer.
 *
 * And it is not a failure state. Nothing is lost while it is up, nothing is
 * counting down, and a session started anywhere on the team takes it back
 * down within one poll. It is the one piece of pressure in a game that is
 * otherwise a read-out, and what it asks for is the thing the product is for.
 */
export function BloodVeil({ strength }: { strength: Strength }) {
  const opacity = veilOpacity(strength.strain);
  /*
   * Nothing in the tree at all while the kingdom holds, rather than a
   * transparent element left lying over the field. An invisible full-screen
   * div is a thing that eventually swallows a click.
   */
  if (opacity <= 0) return null;

  return (
    <div
      className="keep-veil"
      /* Decoration. Everything it means is in the HUD, in words. */
      aria-hidden="true"
      style={{ opacity } as React.CSSProperties}
    />
  );
}
