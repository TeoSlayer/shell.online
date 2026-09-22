import { readFileSync } from "node:fs";

const stylesheet = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const landingStylesheet = readFileSync(new URL("../web/landing.css", import.meta.url), "utf8");
const appBaseStylesheet = readFileSync(new URL("../app/src/styles/base.css", import.meta.url), "utf8");
const appPeopleStylesheet = readFileSync(new URL("../app/src/styles/people.css", import.meta.url), "utf8");
const appChatStylesheet = readFileSync(new URL("../app/src/styles/chat.css", import.meta.url), "utf8");
const appShellStylesheet = readFileSync(new URL("../app/src/styles/shell.css", import.meta.url), "utf8");
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
 * do not reach it. The send button was built at a pointer size and shipped
 * that way, at 31px, which is a miss as often as a hit. It is also the only
 * control left in the box -- the row of control-key chips that used to stand
 * above it is gone -- so there is nothing else in there to protect.
 */
if (!/\.chat-send \{\s*width: 44px;\s*height: 44px;/.test(appChatStylesheet)) {
  throw new Error("The chat send button needs a coarse-pointer touch target");
}
if (/\.chat-key\b/.test(appChatStylesheet)) {
  throw new Error("The composer's control-key chips were removed; their rules should go with them");
}

/*
 * The composer is a bar across the foot of the surface rather than a card
 * floating inside it. It floated with eighteen pixels of page either side, so
 * its background stopped short of both edges and the conversation showed past
 * it, which is a blurred panel cut off down both sides.
 */
if (!/\.chat-composer \{\s*right: 0;\s*left: 0;/.test(appChatStylesheet)) {
  throw new Error("The composer must meet both edges of the surface on a phone");
}
/* And the surface it sits on is full-bleed, so there is nothing to meet past. */
if (!/:root\[data-pane="open"\] \.shell-content \{[^}]*padding-inline: 0;/s.test(appShellStylesheet)) {
  throw new Error("A session surface must be full-bleed on a phone");
}
/*
 * One scroller. A session's scrolling belongs to the pane, and an `auto`
 * ancestor around it is a second one for a finger to catch.
 */
if (!/:root\[data-pane="open"\] \.shell-content \{[^}]*overflow: hidden;/s.test(appShellStylesheet)) {
  throw new Error("A session must not nest its pane inside a second scroller");
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
if (!appShellStylesheet.includes(':root[data-pane="open"] .shell')) {
  throw new Error("A session on a phone must be a column one screen tall, not a page that scrolls");
}

/*
 * Sized from a measurement, with `dvh` only as the fallback for the frame
 * before it lands.
 *
 * `100dvh` alone is not the same number on every engine or at every moment:
 * iOS resolves it against the large viewport while the toolbar is expanded,
 * so the first paint puts the bar below the fold, and a toolbar collapsing
 * mid-scroll moves it again. `--app-height` is the layout viewport, measured;
 * `--keyboard-inset` is what the keyboard covers of it. See lib/app-height.ts.
 */
if (!/\.shell \{\s*height: calc\(var\(--app-height/.test(appShellStylesheet)) {
  throw new Error("The phone shell must be sized from --app-height, with dvh only as the fallback");
}

/*
 * A session goes further: one measurement, from one source.
 *
 * `--app-height` less `--keyboard-inset` is correct arithmetic between two
 * numbers that only agree if every engine means the same thing by
 * `window.innerHeight` while a keyboard is up, and the two are published by
 * two modules listening to the same event. When they disagree the column is
 * short by their difference, which is the bottom bar lifted off the foot of
 * the screen with dead page beneath it.
 */
if (!/:root\[data-pane="open"\] \.shell \{\s*height: var\(--visible-height/.test(appShellStylesheet)) {
  throw new Error("A session column must be sized from --visible-height alone, not from two terms that can disagree");
}

/*
 * And a message has to stop short of the far side, or it is not a message.
 * The surface is full-bleed so the composer can meet both edges; the bubbles
 * are not, because the gutter opposite them is what says which way a message
 * is facing.
 */
if (!/\.chat-sent \.chat-bubble,\s*\.chat-received \.chat-bubble \{\s*max-width: 8[0-9]%/.test(appChatStylesheet)) {
  throw new Error("Message bubbles need a gutter on the far side, or they read as panels");
}
/*
 * A full-screen program is the ordinary case on this product, not the
 * exception: every agent it runs draws one. The card that mirrors an
 * unadapted one must not keep a screenful and scroll the rest on a phone,
 * because that is two nested scrollers and the outer one moves the thing
 * being read.
 */
if (!/\.chat-screen-host \{\s*max-height: none;/.test(appChatStylesheet)) {
  throw new Error("A mirrored program must not nest a second vertical scroller inside the thread on a phone");
}
/*
 * And it is sized so the session's whole width is on the screen where that is
 * possible at a legible size; see ChatView.fitMirrors.
 */
if (!appChatStylesheet.includes("font-size: var(--chat-mirror-size")) {
  throw new Error("A mirrored program must be fitted to the session's columns, not drawn at a fixed size");
}

/* The bar holds a row of the session column, so it has to be told to leave. */
if (!appShellStylesheet.includes(':root[data-keyboard="open"] .rail')) {
  throw new Error("The bottom navigation bar must give way to the on-screen keyboard");
}

console.log("Mobile terminal navigation, compact badges, and touch targets passed.");
