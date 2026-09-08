import { readFile, writeFile } from "node:fs/promises";

const required = ["HYPERDRIVE_ID", "FIREBASE_PROJECT_ID", "MAIL_FROM"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`missing deployment configuration: ${missing.join(", ")}`);
}

const replacements = new Map([
  ["__HYPERDRIVE_ID__", process.env.HYPERDRIVE_ID.trim()],
  ["__FIREBASE_PROJECT_ID__", process.env.FIREBASE_PROJECT_ID.trim()],
  ["__MAIL_FROM__", process.env.MAIL_FROM.trim()],
]);

let config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
for (const [placeholder, value] of replacements) {
  if (!config.includes(placeholder)) throw new Error(`missing placeholder ${placeholder}`);
  /* JSON.stringify escapes quotes and control characters before insertion. */
  config = config.replace(placeholder, JSON.stringify(value).slice(1, -1));
}

if (/__[A-Z0-9_]+__/.test(config)) {
  throw new Error("unresolved deployment placeholder");
}

await writeFile(new URL("../wrangler.deploy.jsonc", import.meta.url), config, { mode: 0o600 });
