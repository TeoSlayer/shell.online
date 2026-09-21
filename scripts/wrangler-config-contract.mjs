// Parsed-JSONC validation of the staging Worker config's compatibility_flags. Shared by:
//   - the ordinary test (tests/wrangler-config-contract.test.ts) against the tracked, secret-free
//     contract fixture (tests/fixtures/wrangler.staging.contract.jsonc), and
//   - the deployment preflight (scripts/preflight-staging-config.mjs) against the actual private
//     wrangler.staging.jsonc.
//
// The check is a PARSED validation, not text matching: the config is parsed with jsonc-parser —
// the same package (pinned to the same version) Wrangler itself uses for wrangler.jsonc — so
// comments, trailing commas, and token separation behave exactly as they do for Wrangler
// (e.g. `1/*gap*/2` is a parse error, not `12`). A flag buried in a comment or an unrelated
// field does not satisfy the contract.
//
// Error redaction: every error thrown here is a fixed message. Parser diagnostics (which embed
// offsets/excerpts of the input) are never propagated, so a private config (account id, keys)
// is never printed.

import { readFileSync } from "node:fs";
import { parse as parseJsoncText } from "jsonc-parser";

export const REQUIRED_COMPATIBILITY_FLAGS = ["enable_request_signal"];

// Parse JSONC with Wrangler's own parser (comments, trailing commas, strict token separation).
// A parse failure throws a FIXED message — never the parser's diagnostic (which quotes input).
export function parseJsonc(text) {
  const errors = [];
  const value = parseJsoncText(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error("config is not valid JSONC");
  }
  return value;
}

// Validate that a parsed config carries every required compatibility flag.
export function assertCompatibilityFlags(config) {
  const flags = config?.compatibility_flags;
  if (!Array.isArray(flags)) {
    throw new Error("compatibility_flags is missing or not an array");
  }
  const missing = REQUIRED_COMPATIBILITY_FLAGS.filter((f) => !flags.includes(f));
  if (missing.length > 0) {
    throw new Error(`compatibility_flags is missing required flag(s): ${missing.join(", ")}`);
  }
}

// Read + parse + validate a config file. Throws a fixed message if the file is missing, is not
// valid JSONC, or lacks a required flag. The file path is safe to print; the content is not.
export function validateConfigFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`config file not found: ${filePath}`);
  }
  assertCompatibilityFlags(parseJsonc(text));
}
