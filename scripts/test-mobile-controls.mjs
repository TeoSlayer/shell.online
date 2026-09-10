import { readFileSync } from "node:fs";

const stylesheet = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const landingStylesheet = readFileSync(new URL("../web/landing.css", import.meta.url), "utf8");
const appBaseStylesheet = readFileSync(new URL("../app/src/styles/base.css", import.meta.url), "utf8");
const appPeopleStylesheet = readFileSync(new URL("../app/src/styles/people.css", import.meta.url), "utf8");
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

console.log("Mobile terminal navigation, compact badges, and touch targets passed.");
