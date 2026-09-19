/**
 * Which shape of screen the interface is being drawn on.
 *
 * Not the same question as "how wide is the window", which is what the
 * stylesheet's media queries were asking and why the HUD was full size on a
 * phone held sideways: a handset in landscape is 844 pixels across, sails past
 * every `width <= 640px` rule in the file, and then has 390 pixels of height
 * to fit four panels and a map into. Height is the scarcer axis on the device
 * people actually complained about.
 *
 * A pure function of what a browser can tell us, so it can be tested without
 * one, and so the answer is the same in the stylesheet and in the components.
 */

export type Layout =
  /** A handset, either way up: little room, and a thumb on the glass. */
  | "phone"
  /** A short or narrow window: a tablet, a split screen, a laptop landscape. */
  | "snug"
  /** Room enough for everything. */
  | "room";

export interface Screen {
  width: number;
  height: number;
  /** True for a finger or a stylus: `(pointer: coarse)`. */
  coarse: boolean;
}

/**
 * The shorter edge is what decides it.
 *
 * A phone is a device with about four hundred pixels on its short side
 * whichever way it is held, so measuring that rather than the width gives one
 * answer for both orientations -- which is what stops the interface changing
 * shape when somebody turns their hand over.
 */
export function layoutFor({ width, height, coarse }: Screen): Layout {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (short <= 480 || (coarse && long <= 900)) return "phone";
  if (short <= 700) return "snug";
  return "room";
}

/**
 * Whether this layout should show the trimmed-down HUD.
 *
 * Only a handset. A short desktop window is snug rather than small -- it has
 * room for four corner panels and no thumb over any of them -- and taking a
 * player's purse away because they dragged their window shorter would be the
 * interface deciding it knows better.
 */
export function isCompact(layout: Layout): boolean {
  return layout === "phone";
}
