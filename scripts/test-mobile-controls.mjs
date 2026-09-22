import { readFileSync } from "node:fs";

const stylesheet = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const landingStylesheet = readFileSync(new URL("../web/landing.css", import.meta.url), "utf8");
const appBaseStylesheet = readFileSync(new URL("../app/src/styles/base.css", import.meta.url), "utf8");
const appPeopleStylesheet = readFileSync(new URL("../app/src/styles/people.css", import.meta.url), "utf8");
const appChatStylesheet = readFileSync(new URL("../app/src/styles/chat.css", import.meta.url), "utf8");
const buttonRules = Array.from(
  stylesheet.matchAll(/\.mobile-terminal-keys button\s*\{([^}]*)\}/g),
  (match) => match[1],
);
const mobileRule = buttonRules.find((rule) => rule.includes("touch-action: manipulation"));

if (!mobileRule?.includes("min-height: 44px")) {
  throw new Error("Mobile terminal keys must retain a 44px touch target");
}
if (!mobileRule.includes('font: 600 12px/1 "Uncut Sans", sans-serif')) {
  throw new Error("Mobile terminal key labels must retain their legible size");
}

if (stylesheet.includes(".session-access.encryption { max-width: 30vw")) {
  throw new Error("Mobile encryption labels must not be clipped to 30vw");
}
if (!stylesheet.includes("content: attr(data-compact-label)")) {
  throw new Error("Mobile encryption labels must expose a deliberate compact label");
}

if (!stylesheet.includes(".session-page button") || !stylesheet.includes("min-height: 44px")) {
  throw new Error("Every shared-terminal button needs a coarse-pointer touch target");
}
if (!landingStylesheet.includes(".marketing button") || !landingStylesheet.includes("min-height: 44px")) {
  throw new Error("Landing and documentation controls need coarse-pointer touch targets");
}
if (!landingStylesheet.includes(".knowledge-mobile-menu summary") || !landingStylesheet.includes("min-width: 44px")) {
  throw new Error("The documentation menu needs a full-size mobile target");
}
if (!appBaseStylesheet.includes("button,\n  summary,\n  select") || !appBaseStylesheet.includes("min-height: 44px")) {
  throw new Error("Authenticated-app controls need coarse-pointer touch targets");
}
if (!appBaseStylesheet.includes("button[aria-label]") || !appBaseStylesheet.includes("min-width: 44px")) {
  throw new Error("Authenticated-app icon controls need a full-width touch target");
}
if (!appPeopleStylesheet.includes("@media (max-width: 1500px)") || !appPeopleStylesheet.includes(".table-optional")) {
  throw new Error("Session actions must retain their width before the app rail crowds the table");
}

/*
 * The chat renderer draws its own controls rather than using the app's
 * buttons, so the rules that give every other control a finger-sized target
 * do not reach it. These were built at pointer sizes and shipped that way:
 * a 31px send button and 21px key chips, both a miss as often as a hit.
 */
if (!appChatStylesheet.includes(".chat-key {\n    min-height: 44px;")) {
  throw new Error("Chat key chips need a coarse-pointer touch target");
}
if (!appChatStylesheet.includes(".chat-send {\n    width: 44px;\n    height: 44px;")) {
  throw new Error("The chat send button needs a coarse-pointer touch target");
}
/*
 * Safari on iOS zooms the page in when a field smaller than 16px is focused,
 * and leaves it zoomed. The composer is the only field in a session, so this
 * one declaration is the difference between typing a command and pinching
 * back out afterwards.
 *
 * Keyed to the pointer rather than to the width. It used to live in the phone
 * breakpoint, which meant a tablet -- wide enough to miss the breakpoint, and
 * with exactly the same on-screen keyboard -- zoomed itself in on every tap
 * into the box.
 */
if (!/@media \(pointer: coarse\), \(max-width: 760px\)\s*\{\s*\.chat-input\s*\{\s*font-size: 16px;/.test(appChatStylesheet)) {
  throw new Error("The chat composer must be 16px wherever there is a finger, or iOS zooms the session in");
}

/*
 * Nothing in the composer waits for a double tap, and a double tap without
 * this is the browser zooming the page in on the box somebody was aiming at.
 * The two blocks in a conversation wide enough to be swiped sideways need the
 * same, or the second finger of a swipe is read as a pinch.
 */
if (!/\.chat-composer \{[^}]*touch-action: manipulation;/s.test(appChatStylesheet)) {
  throw new Error("The chat composer must refuse double-tap zoom");
}
if (!/\.chat-screen-host \{\s*touch-action: pan-x pan-y;/.test(appChatStylesheet)) {
  throw new Error("Blocks that scroll sideways must refuse pinch zoom");
}

/*
 * A session is one screen tall and does not scroll, so the composer's foot is
 * the foot of the screen rather than the foot of whatever box the pane was
 * measured into. This is what keeps it out of the middle of the page.
 */
const appShellStylesheet = readFileSync(new URL("../app/src/styles/shell.css", import.meta.url), "utf8");
if (!appShellStylesheet.includes(':root[data-pane="open"] .shell')) {
  throw new Error("A session on a phone must be a column one screen tall, not a page that scrolls");
}
/* The bar holds a row of the session column, so it has to be told to leave. */
if (!appShellStylesheet.includes(':root[data-keyboard="open"] .rail')) {
  throw new Error("The bottom navigation bar must give way to the on-screen keyboard");
}

console.log("Mobile terminal navigation, compact badges, and touch targets passed.");
