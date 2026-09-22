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
