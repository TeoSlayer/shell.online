import { readFileSync } from "node:fs";

const stylesheet = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
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

console.log("Mobile terminal navigation and compact badges passed.");
