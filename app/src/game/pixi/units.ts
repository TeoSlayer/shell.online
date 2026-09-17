/**
 * Which unit sprite stands for which class.
 *
 * Kenney's pack has four colours of unit; they are used here to tell the
 * classes apart at a glance, which is what a colour is for on a map where
 * everything is the same size.
 *
 * Its own file because two places need it now. The renderer draws the figure on
 * the map, and the shop draws the same figure in the list so that what is on
 * sale is the thing that will be standing out there. Two copies of this map
 * would drift, and the drift would be a shop showing one soldier and delivering
 * another.
 */
export const UNIT_FOR: Record<string, string> = {
  "claude-code": "Unit_05",
  codex: "Unit_01",
  hermes: "Unit_11",
  openclaw: "Unit_07",
  terminal: "Unit_17",
  soldier: "Unit_19",
  /* The Unmade get the darkest units, tinted so they read as wrong. */
  mite: "Unit_21",
  crawler: "Unit_23",
  heisenbug: "Unit_09",
};

/** The sprite for a class, falling back to the plain terminal figure. */
export function unitFor(kind: string): string {
  return UNIT_FOR[kind] ?? UNIT_FOR.terminal;
}
