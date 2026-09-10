// Refuse production bundles that contain loopback service URLs.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2] ?? "dist";

/* Loopback in any form a URL can take. */
const FORBIDDEN = [/\blocalhost:\d+/gu, /\b127\.0\.0\.1:\d+/gu, /\b0\.0\.0\.0:\d+/gu, /\[::1\]:\d+/gu];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(?:js|css|html)$/u.test(entry.name)) yield path;
  }
}

const found = [];
for await (const path of files(directory)) {
  const body = await readFile(path, "utf8");
  for (const pattern of FORBIDDEN) {
    for (const match of body.matchAll(pattern)) {
      const at = match.index ?? 0;
      found.push({ path, value: match[0], near: body.slice(Math.max(0, at - 60), at + 30) });
    }
  }
}

if (found.length > 0) {
  console.error(`check-bundle: ${found.length} loopback reference(s) in the production build`);
  for (const { path, value, near } of found.slice(0, 10)) {
    console.error(`  ${path}: ${value}`);
    console.error(`    ...${near.replace(/\s+/gu, " ")}`);
  }
  console.error("  A deployed page cannot reach the reader's own machine.");
  console.error("  Check .env.production against .env.local, then rebuild.");
  process.exit(1);
}

// Required Vite values must be present and non-empty in the compiled bundle.
const REQUIRED = [
  "VITE_RELAY_URL",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
];

const blank = [];
for await (const path of files(directory)) {
  if (!path.endsWith(".js")) continue;
  const body = await readFile(path, "utf8");
  if (!body.includes("VITE_")) continue;
  for (const key of REQUIRED) {
    // Vite inlines these values into an object in the compiled JavaScript.
    const match = body.match(new RegExp(`${key}\\s*:\\s*(["'\`])((?:(?!\\1).)*)\\1`, "u"));
    if (!match) blank.push({ path, key, why: "absent" });
    else if (match[2].trim() === "") blank.push({ path, key, why: "empty" });
  }
}

if (blank.length > 0) {
  console.error("check-bundle: required values are missing from the production build");
  for (const { path, key, why } of blank) console.error(`  ${path}: ${key} is ${why}`);
  console.error("  Absent means the build had no value at all: no .env.local on this");
  console.error("  machine, or no env block in the workflow step. Empty means something");
  console.error("  passed an empty string and overrode app/.env.production.");
  console.error("  Either way the page throws on load and renders nothing."); 
  process.exit(1);
}

console.log("check-bundle: no loopback addresses in the production build.");
