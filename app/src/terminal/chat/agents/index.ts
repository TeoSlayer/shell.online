/**
 * Which adapter, if any, can read the program on the screen.
 *
 * Asked on every frame until one answers, and then not again. It used to be
 * asked once, on the first frame after a program took the screen, which is
 * the frame least likely to say anything useful: an agent draws a splash and
 * then its conversation, and a resumed session starts part-way through one.
 * Asking once meant a program that could have been read was not.
 *
 * Nothing matching is the ordinary case and not a failure. An editor, a
 * pager, `top`: none of those are a conversation, and the renderer mirrors
 * their grid rather than guessing at it.
 */

import { KNOWN_AGENTS } from "./known";
import type { AgentAdapter } from "./types";

export type { AgentAdapter, AgentUtterance } from "./types";
export { RepaintReader } from "./stream";
export { ClaudeCodeAdapter } from "./claude-code";
export { KNOWN_AGENTS } from "./known";

export function adapterFor(frame: readonly string[], title?: string): AgentAdapter | null {
  for (const make of KNOWN_AGENTS) {
    const adapter = make();
    if (adapter.matches(frame, title)) return adapter;
  }
  return null;
}
