// Mandatory staging deployment wrapper. Replaces the old `preflight && npx wrangler deploy …`
// npm chain, where arguments forwarded after `npm run deploy:staging --` were appended to the
// WHOLE chain and could override the validated `--config`/`--env-file`/target (e.g. a forwarded
// `--config wrangler.production.jsonc` would deploy production after the staging preflight passed).
//
// The wrapper owns every wrangler flag: it builds the argv itself, runs the parsed-JSONC
// preflight against the EXACT config file it will deploy, and rejects any caller-supplied
// argument instead of forwarding it. The executor is injectable so tests run a stub (no real
// deployment).
//
// Usage: node ./scripts/deploy-staging.mjs        (via: npm run deploy:staging)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateConfigFile } from "./wrangler-config-contract.mjs";

export const STAGING_CONFIG = "wrangler.staging.jsonc";
export const STAGING_ENV_FILE = ".dev.vars.staging";

// The exact wrangler argv the wrapper runs. The config path is the SAME resolved path the
// preflight validated — never a second, unvalidated default. Nothing else is ever passed to
// wrangler.
export function stagingDeployArgv(configPath = resolve(STAGING_CONFIG)) {
  return ["deploy", "--config", configPath, "--env-file", STAGING_ENV_FILE];
}

// The wrapper owns all wrangler flags: any caller-supplied argument is an unsafe override and is
// rejected, not forwarded. The arguments are NOT echoed in the error — a forwarded value may be a
// credential (e.g. `--var TOKEN=…`), and the error message is printed to the terminal.
export function validateDeployArgs(argv) {
  if (argv.length > 0) {
    return {
      ok: false,
      error: `unexpected argument(s) — the staging deploy wrapper owns all wrangler flags; edit ${STAGING_CONFIG} instead`,
    };
  }
  return { ok: true };
}

// Preflight: parse + validate the EXACT config file that will be deployed. Throws a fixed
// (redacted) message on any failure; a missing config is an error, not a pass.
export function preflightStaging(configPath = resolve(STAGING_CONFIG)) {
  validateConfigFile(configPath);
}

// Default executor: run wrangler via npx with the fixed argv. Returns the exit status.
export function defaultExecutor(argv) {
  const result = spawnSync("npx", ["wrangler", ...argv], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Deploy staging: validate args -> preflight the exact config -> run wrangler with the fixed
// argv. Returns the process exit status (0 ok, 1 preflight/executor failure, 2 usage).
export async function deployStaging({
  argv = [],
  executor = defaultExecutor,
  configPath = resolve(STAGING_CONFIG),
} = {}) {
  const check = validateDeployArgs(argv);
  if (!check.ok) {
    console.error(`deploy:staging FAILED: ${check.error}`);
    return 2;
  }
  try {
    preflightStaging(configPath);
  } catch (err) {
    console.error(`deploy:staging preflight FAILED: ${err.message}`);
    return 1;
  }
  console.log(`deploy:staging preflight OK: ${configPath}`);
  // The SAME resolved configPath the preflight validated — no second, unvalidated default.
  return await Promise.resolve(executor(stagingDeployArgv(configPath)));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  deployStaging({ argv: process.argv.slice(2) }).then((status) => process.exit(status));
}
