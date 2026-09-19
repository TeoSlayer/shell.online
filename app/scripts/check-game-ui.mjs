// Holds the game skin to the rules that make a game playable for everybody.
//
// These come from the game-ui-design skill's validations. They are checked
// rather than remembered because every one of them is invisible on the machine
// it was written on: a 12px label is fine on a laptop and unreadable across a
// living room, a 24px button is fine under a mouse and unhittable under a
// thumb, and "Press A" is fine until somebody picks up a PlayStation pad.
//
// Where a rule is implemented differently from the skill's own regex, it is
// because the literal pattern produced false positives that would have trained
// everybody to ignore the output. `border: 4px solid` contains "width: 4px"
// once the shorthand is expanded, and a lint nobody believes is worse than no
// lint. Each departure is noted at the rule.
//
//   node scripts/check-game-ui.mjs
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOTS = ["src/game", "src/styles/game.css"];

/** Minimums, at the reference scale. */
const MIN_FONT_PX = 16;
const MIN_HIT_PX = 44;
const MAX_MOTION_MS = 300;
const MAX_Z_INDEX = 400;

/** Selectors that describe something a player points at, clicks or focuses. */
const INTERACTIVE = /button|input|select|textarea|\ba\b|\[role=|menu-item|keep-button|keep-choice|keep-key/i;

async function* walk(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    // A file rather than a directory.
    yield path;
    return;
  }
  for (const entry of entries) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) yield* walk(next);
    else yield next;
  }
}

const problems = [];
const note = (file, line, rule, message, fix) =>
  problems.push({ file, line, rule, message, fix });

/** The 1-based line a character offset falls on. */
const lineAt = (body, index) => body.slice(0, index).split("\n").length;

/*
 * Splits a stylesheet into { selector, body, line } blocks.
 *
 * Deliberately simple: this only has to understand the one stylesheet in this
 * repository, and a real CSS parser is a dependency for a build check.
 * At-rules are kept, because their contents still need checking.
 */
function rules(css) {
  const found = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    found.push({
      selector: match[1].trim(),
      body: match[2],
      line: lineAt(css, match.index ?? 0),
    });
  }
  return found;
}

function checkStylesheet(file, css) {
  // --- text nobody can read ------------------------------------------------
  //
  // Literal pixel sizes only. Everything in game.css is written as
  // calc(16px * var(--keep-scale)) so the interface-size slider moves it, and
  // those are the sizes that are already correct.
  for (const match of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
    const size = Number(match[1]);
    if (size >= MIN_FONT_PX) continue;
    note(
      file, lineAt(css, match.index), "font-too-small",
      `font-size: ${size}px is below the ${MIN_FONT_PX}px floor`,
      "Game text is read across a room and on a handheld. Use var(--keep-text) or larger.",
    );
  }

  // --- things too small to hit ---------------------------------------------
  //
  // Scoped to interactive rules, unlike the skill's own pattern, which matches
  // any width or height and so flags every border shorthand in the file.
  for (const rule of rules(css)) {
    if (!INTERACTIVE.test(rule.selector)) continue;
    for (const match of rule.body.matchAll(/(?:^|[;\s])(min-)?(width|height):\s*(\d+(?:\.\d+)?)px/g)) {
      const size = Number(match[3]);
      if (size >= MIN_HIT_PX) continue;
      note(
        file, rule.line, "touch-target-too-small",
        `${rule.selector} sets ${match[2]}: ${size}px`,
        `Anything you can hit needs ${MIN_HIT_PX}px. Use var(--keep-hit), or expand the hit area around a smaller visual.`,
      );
    }
  }

  // --- motion that makes people ill ---------------------------------------
  for (const match of css.matchAll(/(?:animation|transition)(?:-duration)?:[^;]*?(\d+(?:\.\d+)?)(ms|s)\b/g)) {
    const ms = match[2] === "s" ? Number(match[1]) * 1000 : Number(match[1]);
    if (ms <= MAX_MOTION_MS) continue;
    note(
      file, lineAt(css, match.index), "motion-too-long",
      `a ${ms}ms duration is over the ${MAX_MOTION_MS}ms ceiling`,
      "Long interface motion reads as lag and can cause nausea. Shorten it.",
    );
  }

  // --- a layering scale, not a layering war --------------------------------
  for (const match of css.matchAll(/z-index:\s*(\d+)/g)) {
    const value = Number(match[1]);
    if (value <= MAX_Z_INDEX) continue;
    note(
      file, lineAt(css, match.index), "z-index-war",
      `z-index: ${value} is above the ${MAX_Z_INDEX} ceiling`,
      "Use the named scale on .keep: --keep-z-hud, --keep-z-modal, --keep-z-tooltip, --keep-z-toast.",
    );
  }

  // --- focus somebody can see ---------------------------------------------
  //
  // Removing the outline is fine; removing it with nothing in its place means
  // a pad can move focus somewhere invisible, which is the same as losing it.
  if (/outline:\s*(none|0)\b/.test(css) && !/:focus-visible/.test(css)) {
    const match = css.match(/outline:\s*(none|0)\b/);
    note(
      file, lineAt(css, match.index), "focus-invisible",
      "the outline is removed and nothing replaces it",
      "Add a :focus-visible rule with a visible ring.",
    );
  }

  // --- a way to turn the movement off --------------------------------------
  if (/@keyframes|animation:/.test(css) && !/prefers-reduced-motion/.test(css)) {
    note(
      file, 1, "no-reduced-motion",
      "this stylesheet animates but never checks prefers-reduced-motion",
      "Add a @media (prefers-reduced-motion: reduce) block that stops it.",
    );
  }
}

function checkSource(file, source) {
  // --- buttons the player may not have -------------------------------------
  //
  // The one rule with a deliberate exception: input.ts is the table that
  // resolves an action to whatever this player is holding, so it is the only
  // place allowed to name a button at all.
  if (!file.endsWith("engine/input.ts")) {
    for (const match of source.matchAll(
      /["'`](?:Press|Hit|Tap|Push)\s+(?:A|B|X|Y|Start|Select|Space|Enter|Esc|LB|RB|LT|RT|L1|R1|L2|R2)\b/g,
    )) {
      note(
        file, lineAt(source, match.index), "hardcoded-button-prompt",
        `${match[0].slice(1)}… names a physical button`,
        "Use <Prompt action=\"confirm\" verb=\"…\" />, which resolves to the device in the player's hands.",
      );
    }
  }

  // --- inline text too small to read ---------------------------------------
  for (const match of source.matchAll(/fontSize:\s*["']?(\d+)(?:px)?["']?/g)) {
    const size = Number(match[1]);
    if (size >= MIN_FONT_PX) continue;
    note(
      file, lineAt(source, match.index), "font-too-small",
      `fontSize: ${size} is below the ${MIN_FONT_PX}px floor`,
      "Style it in game.css against the --keep-text scale instead.",
    );
  }

  // --- layering, again, for anything set inline ----------------------------
  for (const match of source.matchAll(/zIndex:\s*["']?(\d+)/g)) {
    const value = Number(match[1]);
    if (value <= MAX_Z_INDEX) continue;
    note(
      file, lineAt(source, match.index), "z-index-war",
      `zIndex: ${value} is above the ${MAX_Z_INDEX} ceiling`,
      "Use the named scale on .keep.",
    );
  }
}

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    let body;
    try {
      body = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (file.endsWith(".css")) checkStylesheet(file, body);
    else if (/\.tsx?$/.test(file)) checkSource(file, body);
  }
}

if (problems.length > 0) {
  console.error(`check-game-ui: ${problems.length} problem(s) in the game skin\n`);
  for (const { file, line, rule, message, fix } of problems) {
    console.error(`  ${file}:${line}  [${rule}]`);
    console.error(`    ${message}`);
    console.error(`    ${fix}\n`);
  }
  console.error("  These come from the game-ui-design skill. Each one is something");
  console.error("  that works on the machine it was written on and fails on somebody");
  console.error("  else's television, handheld, or controller.");
  process.exit(1);
}

console.log("check-game-ui: the game skin meets the readability and input rules.");
