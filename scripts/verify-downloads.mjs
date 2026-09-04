import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "dist/downloads");
const packageMetadata = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const targets = (await readFile(resolve("scripts/release-targets.tsv"), "utf8"))
  .split("\n")
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.split("\t"));
const binaries = targets.map(([artifact]) => artifact);
if (new Set(binaries).size !== binaries.length || targets.some((row) => row.length !== 4)) {
  fail("release target manifest is invalid");
}
const signedArtifacts = [...binaries, "install", "install.ps1", "SKILL.md", "release.json"];
const requiredFiles = [
  ...signedArtifacts,
  ...binaries.map((name) => `${name}.sha256`),
  "release.json.sha256",
  "SHA256SUMS",
];

function fail(message) {
  throw new Error(`invalid download bundle: ${message}`);
}

async function digest(filename) {
  const body = await readFile(resolve(directory, filename));
  if (body.subarray(0, 32).toString("utf8").trimStart().toLowerCase().startsWith("<!doctype html")) {
    fail(`${filename} contains HTML`);
  }
  return createHash("sha256").update(body).digest("hex");
}

for (const filename of requiredFiles) {
  let details;
  try {
    details = await stat(resolve(directory, filename));
  } catch {
    fail(`${filename} is missing`);
  }
  if (!details.isFile() || details.size === 0) fail(`${filename} is empty`);
}
for (const filename of binaries) {
  const details = await stat(resolve(directory, filename));
  if (details.size < 1_000_000) fail(`${filename} is implausibly small (${details.size} bytes)`);
}

const manifestText = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
const manifest = new Map();
for (const line of manifestText.trim().split("\n")) {
  const match = line.match(/^([a-f0-9]{64}) {2}(\S+)$/);
  if (!match || manifest.has(match[2])) fail(`SHA256SUMS contains an invalid entry: ${line}`);
  manifest.set(match[2], match[1]);
}
for (const filename of signedArtifacts) {
  const expected = manifest.get(filename);
  if (!expected) fail(`SHA256SUMS has no entry for ${filename}`);
  const actual = await digest(filename);
  if (actual !== expected) fail(`${filename} checksum is ${actual}, expected ${expected}`);
}

for (const filename of [...binaries, "release.json"]) {
  const sidecar = (await readFile(resolve(directory, `${filename}.sha256`), "utf8")).trim();
  const expected = `${manifest.get(filename)}  ${filename}`;
  if (sidecar !== expected) fail(`${filename}.sha256 does not match SHA256SUMS`);
}

let release;
try {
  release = JSON.parse(await readFile(resolve(directory, "release.json"), "utf8"));
} catch {
  fail("release.json is not valid JSON");
}
if (release.version !== packageMetadata.version) {
  fail(`release.json version ${release.version ?? "<missing>"} does not match package ${packageMetadata.version}`);
}
if (release.algorithm !== "sha256" || typeof release.artifacts !== "object" || release.artifacts === null) {
  fail("release.json has invalid metadata");
}
for (const filename of [...binaries, "install", "install.ps1", "SKILL.md"]) {
  if (release.artifacts[filename] !== manifest.get(filename)) {
    fail(`release.json checksum for ${filename} does not match SHA256SUMS`);
  }
}

console.log(`Verified ${requiredFiles.length} download files for shell ${packageMetadata.version}.`);
