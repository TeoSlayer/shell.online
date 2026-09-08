/**
 * The Homebrew formula names a version and the checksum of that tag's tarball.
 * Both are written by hand at release time and neither is exercised by
 * anything else, so both go wrong quietly: a stale version installs the
 * previous release, and a placeholder checksum fails for every user who runs
 * `brew install` while looking exactly like a network problem.
 *
 * Until a release tag exists, the formula must continue to describe the last
 * published release. On a tag build it must move to that tag and carry the
 * real archive checksum. CI passes the ref; locally the check validates the
 * stable formula without pretending an unreleased archive exists.
 *
 *   node ./scripts/check-formula.mjs
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PLACEHOLDER = "REPLACE_WITH_TAG_TARBALL_SHA256";

const formula = await readFile(resolve("Formula/shell-online.rb"), "utf8");
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));

function fail(message) {
  console.error(`invalid Homebrew formula: ${message}`);
  process.exit(1);
}

const url = formula.match(/^\s*url\s+"(.+)"$/m)?.[1];
const sha256 = formula.match(/^\s*sha256\s+"(.+)"$/m)?.[1];
if (!url || !sha256) fail("it declares no url or no sha256");

/* The tarball a tag serves, so the version has to be the tag's. */
const tagged = url.match(/\/tags\/v(.+)\.tar\.gz$/)?.[1];
if (!tagged) fail(`url is not a tag tarball: ${url}`);
/* A typo here is a checksum mismatch on someone else's machine. */
if (sha256 !== PLACEHOLDER && !/^[0-9a-f]{64}$/.test(sha256)) {
  fail(`sha256 is neither the placeholder nor 64 hex characters: ${sha256}`);
}

/*
 * GITHUB_REF is set for every GitHub Actions run and names a tag only on a
 * tag build. Anywhere else, an unfilled checksum is expected.
 */
const ref = process.env.GITHUB_REF ?? "";
if (ref.startsWith("refs/tags/")) {
  const released = ref.slice("refs/tags/v".length);
  if (released !== version) fail(`${ref} does not match package.json v${version}`);
  if (tagged !== released) fail(`formula is v${tagged} on ${ref}`);
  if (sha256 === PLACEHOLDER) fail(`the checksum is still the placeholder on ${ref}`);
}

const state = sha256 === PLACEHOLDER ? "checksum pending its tag" : "checksum set";
console.log(`Homebrew formula tracks ${tagged}, ${state}; package is ${version}.`);
