#!/usr/bin/env node
/*
 * Fails when a vendored protocol module has drifted from its upstream copy in
 * the shell.online checkout. Skips silently when that checkout is absent, so
 * the app still builds on a machine that only has this repository.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/*
 * The app lives inside the shell.online repository, so upstream is the
 * directory above it. It used to be a sibling checkout; pointing at the old
 * path here would make this check pass by finding nothing to compare.
 */
const upstream = process.env.SHELL_ONLINE_REPO ?? join(here, "..", "..");

const FILES = [
  { vendored: "src/terminal/protocol.ts", source: "shared/protocol.ts" },
  { vendored: "src/terminal/e2ee.ts", source: "web/e2ee.ts" },
];

/* Copies kept in step within this repository rather than with shell.online. */
const LOCAL = [
  { vendored: "src/lib/mentions.ts", source: "server/lib/mentions.ts" },
];

if (!existsSync(upstream)) {
  console.log(`check:protocol: no shell.online checkout at ${upstream}, skipping`);
  process.exit(0);
}

let drifted = false;
for (const { vendored, source } of FILES) {
  const sourcePath = join(upstream, source);
  if (!existsSync(sourcePath)) {
    console.error(`check:protocol: upstream ${source} is missing`);
    drifted = true;
    continue;
  }
  /* The vendored copy carries a provenance header; compare the body only. */
  const body = readFileSync(join(here, "..", vendored), "utf8").replace(/^\/\*[\s\S]*?\*\/\n/, "");
  if (body !== readFileSync(sourcePath, "utf8")) {
    console.error(`check:protocol: ${vendored} has drifted from ${source}`);
    drifted = true;
  }
}

for (const { vendored, source } of LOCAL) {
  const body = readFileSync(join(here, "..", vendored), "utf8").replace(/^\/\*[\s\S]*?\*\/\n\n/, "");
  if (body !== readFileSync(join(here, "..", source), "utf8")) {
    console.error(`check:protocol: ${vendored} has drifted from ${source}`);
    drifted = true;
  }
}

if (drifted) {
  console.error("Re-sync with: npm run sync:protocol");
  process.exit(1);
}
console.log("check:protocol: vendored modules match upstream");
