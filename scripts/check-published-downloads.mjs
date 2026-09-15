// Check what a deployment is serving for every install path, from outside.
//
//   node scripts/check-published-downloads.mjs [origin] [--json <file>] [--markdown <file>] [--samples a,b]
//
// Fetches the two install scripts, the checksum and release manifests, a HEAD
// of every release binary in scripts/release-targets.tsv, and the full bytes of
// a few sample binaries, then judges them with scripts/lib/published-downloads.mjs.
// Exit 1 when any check fails. verify-published.mjs compares a deployment with a
// local build; this needs no build, so it can run on a schedule from anywhere.
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  DEFAULT_SAMPLES,
  evaluate,
  parseReleaseTargets,
  renderReport,
} from "./lib/published-downloads.mjs";

const args = process.argv.slice(2);
const options = { origin: "https://shell.online", json: null, markdown: null, samples: DEFAULT_SAMPLES };
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--json") options.json = args[++index];
  else if (arg === "--markdown") options.markdown = args[++index];
  else if (arg === "--samples") options.samples = args[++index].split(",").map((name) => name.trim()).filter(Boolean);
  else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
  else options.origin = arg;
}
const origin = options.origin.replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;

function fail(message) {
  console.error(`check-published-downloads: ${message}`);
  process.exit(2);
}

const sha256 = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/* Cache-busted, so a stale edge copy cannot make a broken deployment look healthy. */
function url(path) {
  return `${origin}${path}?cache-bust=${Date.now()}`;
}

async function fetchFile(path) {
  try {
    const response = await fetch(url(path), {
      headers: { "cache-control": "no-cache", "user-agent": "shell.online-downloads-check" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, contentType: response.headers.get("content-type"), bytes };
  } catch (error) {
    return { status: 0, contentType: null, bytes: new Uint8Array(), error: error.message };
  }
}

/* HEAD first; a deployment that refuses HEAD gets a one-byte ranged GET instead. */
async function fetchHead(name) {
  const headers = { "cache-control": "no-cache", "user-agent": "shell.online-downloads-check" };
  try {
    let response = await fetch(url(`/downloads/${name}`), { method: "HEAD", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url(`/downloads/${name}`), { headers: { ...headers, range: "bytes=0-0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      await response.arrayBuffer();
    }
    const range = response.headers.get("content-range")?.match(/\/(\d+)$/);
    const length = range ? Number(range[1]) : response.headers.get("content-length") !== null ? Number(response.headers.get("content-length")) : null;
    return { status: response.status, contentType: response.headers.get("content-type"), length };
  } catch (error) {
    return { status: 0, contentType: null, length: null, error: error.message };
  }
}

async function inBatches(items, worker) {
  const results = {};
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      results[item] = await worker(item);
    }
  }));
  return results;
}

const artifacts = parseReleaseTargets(await readFile(new URL("./release-targets.tsv", import.meta.url), "utf8"));
const checkedAt = new Date().toISOString();

/*
 * The scripts are fetched from the site root, which is what the docs tell
 * people to run; everything else lives under /downloads/, where the scripts
 * are also copied and where SHA256SUMS lists them.
 */
const paths = {
  install: "/install",
  "install.ps1": "/install.ps1",
  SHA256SUMS: "/downloads/SHA256SUMS",
  "release.json": "/downloads/release.json",
  ...Object.fromEntries(options.samples.map((name) => [name, `/downloads/${name}`])),
};
const [files, binaries] = await Promise.all([
  inBatches(Object.keys(paths), (name) => fetchFile(paths[name])),
  inBatches(artifacts, fetchHead),
]);

const verdict = evaluate({ artifacts, fetched: { files, binaries }, samples: options.samples, sha256 });
const report = renderReport({ origin, checkedAt, ...verdict });

process.stdout.write(report);
if (options.markdown) await writeFile(options.markdown, report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
if (options.json) {
  await writeFile(options.json, JSON.stringify({
    origin,
    checkedAt,
    ok: verdict.ok,
    version: verdict.version,
    checks: verdict.checks,
    binaries: verdict.binaries,
  }, null, 2));
}
process.exit(verdict.ok ? 0 : 1);
