import { readFile, writeFile } from "node:fs/promises";

const required = ["HYPERDRIVE_ID", "MAIL_FROM"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`missing deployment configuration: ${missing.join(", ")}`);
}

/*
 * Either spelling of the identity provider, but one of them. OIDC_ISSUER and
 * OIDC_AUDIENCE name any provider; FIREBASE_PROJECT_ID is the older shorthand
 * for the Firebase one. A deployment with neither would render a Worker whose
 * every API call is refused, which is worth failing here rather than there.
 */
const value = (name) => process.env[name]?.trim() ?? "";
if (!value("OIDC_ISSUER") && !value("FIREBASE_PROJECT_ID")) {
  throw new Error("missing deployment configuration: OIDC_ISSUER or FIREBASE_PROJECT_ID");
}
if (value("OIDC_ISSUER") && !value("OIDC_AUDIENCE")) {
  throw new Error("missing deployment configuration: OIDC_AUDIENCE, beside OIDC_ISSUER");
}

const replacements = new Map([
  ["__HYPERDRIVE_ID__", value("HYPERDRIVE_ID")],
  ["__OIDC_ISSUER__", value("OIDC_ISSUER")],
  ["__OIDC_AUDIENCE__", value("OIDC_AUDIENCE")],
  ["__FIREBASE_PROJECT_ID__", value("FIREBASE_PROJECT_ID")],
  ["__MAIL_FROM__", value("MAIL_FROM")],
]);

let config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
for (const [placeholder, replacement] of replacements) {
  if (!config.includes(placeholder)) throw new Error(`missing placeholder ${placeholder}`);
  /* JSON.stringify escapes quotes and control characters before insertion. */
  config = config.replace(placeholder, JSON.stringify(replacement).slice(1, -1));
}

if (/__[A-Z0-9_]+__/.test(config)) {
  throw new Error("unresolved deployment placeholder");
}

await writeFile(new URL("../wrangler.deploy.jsonc", import.meta.url), config, { mode: 0o600 });
