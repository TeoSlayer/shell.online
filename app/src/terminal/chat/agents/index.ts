/**
 * Which adapter, if any, can read the program on the screen.
 *
 * Asked once per full-screen program rather than once per frame: recognising
 * an interface is a search through every line of a grid, and the program
 * drawing it does not change while it is running.
 *
 * Nothing matching is the ordinary case and not a failure. An editor, a
 * pager, `top`, an agent nobody has written an adapter for: none of those are
 * a conversation, and the renderer has an honest answer for them that does
 * not involve guessing at their screens. See known.ts for which agents are
 * read from a captured frame and which from the shape they share.
 */

import { KNOWN_AGENTS } from "./known";
import type { AgentAdapter } from "./types";

export type { AgentAdapter, AgentUtterance } from "./types";
export { RepaintReader } from "./stream";
export { BoxedAgent } from "./boxed-agent";
export { KNOWN_AGENTS } from "./known";

export function adapterFor(frame: readonly string[]): AgentAdapter | null {
  for (const make of KNOWN_AGENTS) {
    const adapter = make();
    if (adapter.matches(frame)) return adapter;
  }
  return null;
}
