#!/usr/bin/env node
/*
 * Generates SUMMARY_TICKET_KEY for the accounts service and prints the public
 * key the attested summarizer embeds in its image (summary protocol v1, §3).
 *
 *   node app/scripts/summary-ticket-key.mjs
 *
 * The seed is a secret: set it with `wrangler secret put SUMMARY_TICKET_KEY`
 * (or the Node server's secret environment) and never commit or log it. The
 * public key is not secret; it goes into the summarizer's source so that it is
 * covered by the attested image digest.
 *
 * Pass --public <seed> to print the public key for an existing seed.
 */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function publicKeyFor(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return createPublicKey(privateKey).export({ format: "jwk" }).x;
}

const args = process.argv.slice(2);
if (args[0] === "--public") {
  const seed = Buffer.from(args[1] ?? "", "base64url");
  if (seed.length !== 32 || seed.toString("base64url") !== args[1]) {
    console.error("expected a b64u 32-byte seed");
    process.exit(2);
  }
  console.log(publicKeyFor(seed));
} else if (args.length === 0) {
  const seed = randomBytes(32);
  console.log(`SUMMARY_TICKET_KEY (secret)       ${seed.toString("base64url")}`);
  console.log(`ticket public key (for the enclave) ${publicKeyFor(seed)}`);
  seed.fill(0);
} else {
  console.error("usage: summary-ticket-key.mjs [--public <seed>]");
  process.exit(2);
}
