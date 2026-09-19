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
];

const AUTH_GROUPS = [
  ["VITE_OIDC_ISSUER", "VITE_OIDC_CLIENT_ID"],
  [
    "VITE_FIREBASE_API_KEY",
    "VITE_FIREBASE_AUTH_DOMAIN",
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_FIREBASE_APP_ID",
  ],
];

const blank = [];
let authFound = false;
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
  for (const group of AUTH_GROUPS) {
    const complete = group.every((key) => {
      const match = body.match(new RegExp(`${key}\\s*:\\s*(["'\`])((?:(?!\\1).)*)\\1`, "u"));
      return Boolean(match?.[2].trim());
    });
    if (complete) authFound = true;
  }
}

if (!authFound) blank.push({ path: directory, key: "authentication", why: "neither OIDC nor Firebase is complete" });

if (blank.length > 0) {
  console.error("check-bundle: required values are missing from the production build");
  for (const { path, key, why } of blank) console.error(`  ${path}: ${key} is ${why}`);
  console.error("  Absent means the build had no value at all: no .env.local on this");
  console.error("  machine, or no env block in the workflow step. Empty means something");
  console.error("  passed an empty string and overrode app/.env.production.");
  console.error("  Either way the page throws on load and renders nothing."); 
  process.exit(1);
}

// The game skin must not be in what the corporate view downloads.
//
// src/game carries a renderer, a sprite atlas and a stylesheet of its own, for
// a screen most sessions never open. It is reached through a dynamic import so
// that none of it is fetched until somebody asks for it, and that is the sort
// of property which holds right up until a convenient-looking direct import
// puts it back. So it is checked rather than trusted.
//
// What is checked is everything the browser loads before first paint: the entry
// script, plus the chunks Vite preloads alongside it because the entry imports
// them statically. A lazily-imported chunk appears in neither, which is exactly
// the point.
const KEEP_MARKER = "__SHELL_KEEP__";

async function eagerChunks(dir) {
  let html;
  try {
    html = await readFile(join(dir, "index.html"), "utf8");
  } catch {
    // No index.html means this is not a client build; nothing to check.
    return [];
  }
  const paths = new Set();
  for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+\.js)"/gu)) paths.add(src);
  for (const [, href] of html.matchAll(
    /<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/gu,
  )) {
    paths.add(href);
  }
  // Written as absolute URLs against the site root; read them against dist.
  return [...paths].map((path) => join(dir, path.replace(/^\//u, "")));
}

const leaked = [];
for (const path of await eagerChunks(directory)) {
  let body;
  try {
    body = await readFile(path, "utf8");
  } catch {
    continue;
  }
  if (body.includes(KEEP_MARKER)) leaked.push(path);
}

if (leaked.length > 0) {
  console.error("check-bundle: the game skin is in the bundle the session list loads");
  for (const path of leaked) console.error(`  ${path}`);
  console.error("  src/game is meant to be reached only through the dynamic import in");
  console.error("  src/App.tsx. Something now imports it directly, so every visitor pays");
  console.error("  for a renderer and a sprite atlas to look at a list of sessions.");
  console.error("  Find the static import and make it lazy again.");
  process.exit(1);
}

console.log("check-bundle: no loopback addresses in the production build.");
console.log("check-bundle: the game skin is not in the entry bundle.");
