// Mandatory deployment preflight. Validates the ACTUAL private wrangler config
// (gitignored — never committed) against the same parsed-JSONC compatibility_flags contract the
// ordinary test checks. Run it before every deploy; it fails (non-zero exit) if the config is
// missing or lacks a required flag. It does NOT silently skip: a missing config is an error, not
// a pass. The staging deploy wrapper runs it against the exact config it deploys; the production
// preflight (`npm run preflight:production`) runs it against wrangler.production.jsonc and is
// requires the same cancellation contract before production promotion.
//
// Usage: node ./scripts/preflight-staging-config.mjs [path-to-config]
//        (defaults to ./wrangler.staging.jsonc)

import { resolve } from "node:path";
import { validateConfigFile, REQUIRED_COMPATIBILITY_FLAGS } from "./wrangler-config-contract.mjs";

const configPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve("wrangler.staging.jsonc");

try {
  validateConfigFile(configPath);
  console.log(`preflight OK: ${configPath} carries required compatibility_flags [${REQUIRED_COMPATIBILITY_FLAGS.join(", ")}]`);
} catch (err) {
  console.error(`preflight FAILED: ${configPath}: ${err.message}`);
  console.error("Fix the config (or pass the correct path) before deploying.");
  process.exit(1);
}
