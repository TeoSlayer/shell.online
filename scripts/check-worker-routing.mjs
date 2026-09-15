/*
 * A page the Worker never sees is never counted. Static assets are served
 * before the Worker runs unless their path is in `assets.run_worker_first`,
 * so a deployment config that lists fewer paths than the example config
 * quietly drops those pages from the statistics dashboard. Production once
 * served the web app, CLI, Refstream and platforms guides that way, and
 * "Visited the site" was short by every one of their views and readers.
 *
 * The example config is the reference: a deployment config must route at
 * least what it routes. Run before building, so a bad config costs nothing.
 *
 *   node scripts/check-worker-routing.mjs <reference.jsonc> <deployment.jsonc>
 */
import { readFileSync } from "node:fs";

const [referencePath, deploymentPath] = process.argv.slice(2);
if (!referencePath || !deploymentPath) {
  console.error("usage: check-worker-routing.mjs <reference.jsonc> <deployment.jsonc>");
  process.exit(2);
}

const reference = workerFirstPaths(referencePath);
const deployment = workerFirstPaths(deploymentPath);
const missing = deployment === true || reference === true
  ? []
  : reference.filter((path) => !deployment.includes(path));
if (missing.length > 0) {
  console.error(`${deploymentPath} does not route these paths through the Worker, so their views would never be counted:`);
  for (const path of missing) console.error(`  ${path}`);
  console.error(`Add them to assets.run_worker_first, as in ${referencePath}.`);
  process.exit(1);
}
console.log(`${deploymentPath} routes every counted path through the Worker.`);

/** The `assets.run_worker_first` list, or true when the config routes everything through the Worker. */
function workerFirstPaths(path) {
  let config;
  try {
    config = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
  } catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const paths = config?.assets?.run_worker_first;
  if (paths === true) return true;
  if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string")) {
    console.error(`${path}: assets.run_worker_first must be a list of paths, or true`);
    process.exit(1);
  }
  return paths;
}

/** Comments and trailing commas outside strings, which is all JSONC adds to JSON. */
function stripJsonc(source) {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      const end = closingQuote(source, index);
      output += source.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output.replace(/,(\s*[\]}])/g, "$1");
}

function closingQuote(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === '"') return index;
  }
  return source.length - 1;
}
