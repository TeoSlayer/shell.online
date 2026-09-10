// Compare the published download manifest and a sample binary with ./dist.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const origin = (process.argv[2] ?? "https://shell.online").replace(/\/+$/, "");
const local = JSON.parse(await readFile("dist/downloads/release.json", "utf8"));

const fail = (message) => {
  console.error(`verify-published: ${message}`);
  process.exit(1);
};

const response = await fetch(`${origin}/downloads/release.json?cache-bust=${Date.now()}`, {
  headers: { "cache-control": "no-cache" },
});
if (!response.ok) fail(`${origin}/downloads/release.json answered ${response.status}`);
const published = await response.json();

if (published.version !== local.version) {
  fail(`${origin} publishes ${published.version}, this bundle is ${local.version}`);
}

const differing = Object.keys(local.artifacts).filter(
  (name) => published.artifacts?.[name] !== local.artifacts[name],
);
if (differing.length > 0) {
  fail(
    `${origin} publishes ${differing.length} artifact(s) that differ from this bundle, ` +
      `including ${differing.slice(0, 3).join(", ")}. Deploy again.`,
  );
}

/*
 * The manifest agreeing is not the same as the bytes agreeing: both are
 * uploaded as assets and either can be the stale one.
 */
const sample = "shell-darwin-arm64";
const binary = await fetch(`${origin}/downloads/${sample}?cache-bust=${Date.now()}`);
if (!binary.ok) fail(`${origin}/downloads/${sample} answered ${binary.status}`);
const digest = createHash("sha256").update(Buffer.from(await binary.arrayBuffer())).digest("hex");
if (digest !== local.artifacts[sample]) {
  fail(`${origin} serves a ${sample} that does not match its own manifest`);
}

console.log(
  `verify-published: ${origin} is serving this bundle ` +
    `(${local.version}, ${Object.keys(local.artifacts).length} artifacts).`,
);
