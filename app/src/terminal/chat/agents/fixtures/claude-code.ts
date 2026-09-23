/*
 * Real frames of Claude Code, captured from the program itself.
 *
 * They are here because the first version of this adapter was written against
 * a screen somebody imagined, and everything about it was wrong: the real one
 * has no box drawn round anything, its prompt marker is `❯` rather than `>`,
 * `⏺` marks what the agent said rather than a tool it ran, and the status
 * lines sit *below* the box you type into rather than above it. An adapter
 * written against a guess reads nothing, and reading nothing is the raw grid
 * back on the screen.
 *
 * Captured with a pseudo-terminal at 80x40 and replayed through the same
 * emulator the renderer uses, so these are exactly the rows the adapter is
 * handed. Re-capture them when Claude Code's interface changes; the tests
 * that read them are the warning that it has.
 */

/** Startup: the header is on screen and nothing has been said yet. */
export const CLAUDE_START = [
  "",
  " ▐▛███▛█   Claude Code v2.1.280",
  "▝▜██████▀  Opus 5.5 (1M context) · Claude Max",
  "  ▝▝ ▝▝    /private/tmp",
  "",
  "⚠ Your login expires in 3 days · run /login to renew",
  "",
  "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
  "",
  "                                                            ◐ medium · /effort",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · r…",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

/**
 * A finished exchange. Note what is *not* here: the header has scrolled away,
 * which is why the program's name cannot be the thing that identifies it.
 */
export const CLAUDE_EXCHANGE = [
  "",
  "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
  "",
  "❯ list the files in this directory, then say done",
  "",
  "  Listed 1 directory",
  "",
  "⏺ Here's what's in /private/tmp:",
  "",
  "  Directories",
  "  - 3A0AB48B-…, 79B90E0D-…, 7EEC48CE-… (all empty, named",
  "    by UUID)",
  "  - cc-socks",
  "  - claude-501",
  "",
  "  Named pipes",
  "  - Three pairs of _IN/_OUT pipes: 73792644-…, 89A244CD-…",
  "",
  "  Done.",
  "",
  "✻ Cooked for 13s · done 8:29 PM",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · r…",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

/** The title Claude Code sets with OSC 0, which does not scroll away. */
export const CLAUDE_TITLE = "✳ Claude Code";

/**
 * Mid-typing, nothing sent. Captured by typing into the program and never
 * pressing Return.
 *
 * The line being written has wrapped onto a second row inside the composer,
 * which is the case that reached somebody's phone: read by shape, the second
 * row is ordinary text, so a walk up from the foot of the screen stops there
 * and gives out everything below it -- half a half-finished sentence arriving
 * on another device as a message nobody had sent.
 */
export const CLAUDE_TYPING = [
  "",
  " ▐▛███▛█   Claude Code v2.1.280",
  "▝▜██████▀  Opus 5.5 (1M context) · Claude Max",
  "  ▝▝ ▝▝    /private/tmp",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ this is a long thought that somebody is still in the middle of writing and",
  "  it has wrapped onto several rows of the box",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · r…",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

/*
 * A prompt too long for the terminal, captured the same way as the frames
 * above: driven into a real `claude` through a pty, read back off a real
 * emulator. The program wraps what was typed to the width of the screen and
 * indents the rest of it under the marker, with no blank line between the
 * rows -- which is the same shape as a tool reporting what it did.
 */
export const CLAUDE_WRAPPED_PROMPT: readonly string[] = [
  "",
  " \u2590\u259b\u2588\u2588\u2588\u259b\u2588   Claude Code v2.1.280",
  "\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u2588\u2580  Opus 5.5 (1M context) \u00b7 Claude Max",
  "",
  "\u26a0 Your login expires in 2 days \u00b7 run /login to renew",
  "",
  "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
  "",
  "\u276f Please reply with exactly the single word acknowledged and nothing else, no",
  "  preamble, no explanation, no tool calls, just that one word on its own line",
  "",
  "\u23fa acknowledged",
  "",
  "\u273b Crunched for 4s \u00b7 done 7:01 PM",
  "",
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
  "\u276f",
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
  "  \u23f5\u23f5 auto mode on (shift+tab to cycle)",
];
