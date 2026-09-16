/**
 * Identity of the game chunk.
 *
 * SHELL_KEEP_MARKER is load-bearing: `scripts/check-bundle.mjs` asserts that
 * this string does NOT appear in the entry chunk the corporate view loads. The
 * game is a lazily-imported route and it has to stay that way, so the build
 * fails rather than quietly shipping a game engine to somebody who only wanted
 * a session list.
 *
 * It is written onto the DOM in GameRoute rather than left in a constant a
 * minifier could fold away, because a marker that gets tree-shaken makes the
 * check pass for the wrong reason.
 */
export const SHELL_KEEP_MARKER = "__SHELL_KEEP__";

/** Shown in the pause menu, so a bug report can say which build it came from. */
export const KEEP_BUILD = __SHELL_ONLINE_VERSION__;

/**
 * Where "Quit to boring UI" goes.
 *
 * The session list, not whatever route was visited last: the game can be
 * entered from anywhere, and leaving it should land on the page the game is a
 * skin over rather than back on, say, the terms page.
 */
export const BORING_UI = "/sessions";

/** The name on the tab and the banner. */
export const KEEP_TITLE = "Shell Keep";
