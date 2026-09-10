// Verify that a deployment serves the hashed assets referenced by ./dist.
import { readFile } from "node:fs/promises";

const origin = (process.argv[2] ?? "https://app.shell.online").replace(/\/+$/, "");
const references = (html) => [...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/gu)].map((m) => m[0]);

const local = references(await readFile("dist/index.html", "utf8")).sort();
if (local.length === 0) {
  console.error("verify-deploy: dist/index.html references no hashed assets; build first");
  process.exit(1);
}

const response = await fetch(`${origin}/?cache-bust=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
if (!response.ok) {
  console.error(`verify-deploy: ${origin} answered ${response.status}`);
  process.exit(1);
}
const live = references(await response.text()).sort();

const missing = local.filter((asset) => !live.includes(asset));
if (missing.length > 0) {
  console.error(`verify-deploy: ${origin} is serving a different build than ./dist`);
  console.error(`  built here: ${local.join(", ")}`);
  console.error(`  served:     ${live.join(", ") || "(none)"}`);
  console.error("  Deploy again. The assets upload but the document can stay behind.");
  process.exit(1);
}

/* Reachable is not the same as referenced, so each one is fetched. */
for (const asset of local) {
  const probe = await fetch(`${origin}${asset}`, { method: "HEAD" });
  if (!probe.ok) {
    console.error(`verify-deploy: ${asset} is referenced but answers ${probe.status}`);
    process.exit(1);
  }
}

console.log(`verify-deploy: ${origin} is serving this build (${local.length} assets).`);
