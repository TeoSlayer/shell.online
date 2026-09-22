/**
 * The agents this product knows how to read, and how sure it is of each.
 *
 * Claude Code was written against its screen. The other three were written
 * against the shape the four of them share -- a header box, prompts marked
 * `>`, tool calls marked with a bullet, prose indented under them, and the
 * box you type into at the foot -- and not against a captured frame of their
 * own, because there was none to hand. That difference is recorded here
 * rather than left for somebody to discover.
 *
 * It is a difference in confidence, not in safety. Each one is gated on its
 * own program's name, so no adapter can ever claim another's screen, and the
 * shape degrades in the one direction that is survivable: a line the shape
 * does not recognise is prose, so an agent whose screen turns out to be laid
 * out differently is read as its own text, wrapped to the phone, rather than
 * as something invented. What is lost in that case is the structure -- tool
 * calls read as sentences -- and nothing is lost that was on the screen.
 *
 * The way to promote one of these to Claude Code's footing is to capture a
 * frame of it, put the frame in a test beside the fixture in
 * `boxed-agent.test.ts`, and fix whatever that shows. Until somebody does,
 * `confident` says which is which.
 */

import { BoxedAgent } from "./boxed-agent";
import type { AgentAdapter } from "./types";

/** Each entry makes its own adapter; the adapter carries its own confidence. */
export type KnownAgent = () => AgentAdapter;

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  () => new BoxedAgent({ id: "claude-code", title: "Claude Code", signature: /\bclaude code\b/iu, confident: true }),
  /*
   * `codex` on its own is a word that turns up in directory names and in
   * prose, and the header is the only line any of this is read from, so the
   * name is required to look like a program announcing itself: at the start
   * of a line, or next to a version.
   */
  () => new BoxedAgent({ id: "codex", title: "Codex", signature: /(?:^|\s)codex(?:\s+v?\d|\s*$|\s+cli\b)/iu }),
  () => new BoxedAgent({ id: "hermes", title: "Hermes", signature: /\bhermes\s+(?:agent\b|v?\d)/iu }),
  () => new BoxedAgent({ id: "openclaw", title: "OpenClaw", signature: /\bopenclaw\b/iu }),
];
