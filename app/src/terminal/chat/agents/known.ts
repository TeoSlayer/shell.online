/**
 * The agents this product knows how to read.
 *
 * One, and it is written against frames captured from the program itself.
 *
 * There were four. The other three were written against a shape the four of
 * them were assumed to share, and capturing a real Claude Code screen showed
 * that shape was invented: nothing is drawn in a box, the prompt marker is
 * `❯` and not `>`, and `⏺` is the agent speaking rather than a tool it ran.
 * An adapter built on a guess about one program is a guess about all of them,
 * so the three went with it rather than shipping as reading somebody's screen
 * wrongly. Capture a frame, put it in `fixtures/`, and the adapter that reads
 * it can be written against something real.
 *
 * Codex is worth a note, because it needs no adapter at all: it draws on the
 * normal buffer rather than taking the alternate screen, so its output
 * reaches the conversation as lines and is cut into messages by paragraphs.ts
 * like any other program's. The same is true of a plain shell.
 */

import { ClaudeCodeAdapter } from "./claude-code";
import type { AgentAdapter } from "./types";

/** Each entry makes its own adapter; the adapter carries its own confidence. */
export type KnownAgent = () => AgentAdapter;

export const KNOWN_AGENTS: readonly KnownAgent[] = [() => new ClaudeCodeAdapter()];
