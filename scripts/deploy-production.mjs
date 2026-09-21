// Explicit production target; no caller-supplied Wrangler flags or credential output.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseJsonc, assertCompatibilityFlags } from "./wrangler-config-contract.mjs";

export function assertReleaseVersion(candidate, live) {
  if (![candidate, live].every((v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v))) {
    throw new Error("release identity could not be verified");
  }
  const a = candidate.split(".").map(Number), b = live.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) throw new Error("refusing a version downgrade; reconcile production source first");
    if (a[i] > b[i]) return;
  }
}

export function validateProductionConfig(config) {
  assertCompatibilityFlags(config);
  const routes = (config.routes ?? []).map((r) => r.pattern).sort();
  if (config.name !== "shell-online" || !/^[a-f0-9]{32}$/.test(config.account_id ?? "") ||
      JSON.stringify(routes) !== JSON.stringify(["shell.online", "stats.shell.online"]) ||
      config.vars?.MCP_STAGING_HOSTNAMES !== undefined ||
      !["0", "1"].includes(config.vars?.MCP_CONTROL_ENABLED)) {
    throw new Error("production target, pinned account, or explicit control gate is invalid");
  }
}

export function deployProduction({ argv = [], configPath = resolve("wrangler.production.jsonc"), executor } = {}) {
  if (argv.length) throw new Error("production deploy does not accept forwarded arguments");
  const config = parseJsonc(readFileSync(configPath, "utf8"));
  validateProductionConfig(config);
  // Keep upstream's complete build/download verification and repo-local config staging.
  // Direct Wrangler deployment here would drop release assets or deploy a different checkout.
  const script = fileURLToPath(new URL("./deploy-production.sh", import.meta.url));
  const run = executor ?? ((args, options) => spawnSync("sh", args, options).status ?? 1);
  return run([script], { stdio: "inherit", env: { ...process.env, SHELL_ONLINE_WRANGLER_CONFIG: resolve(configPath) } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error("forwarded arguments forbidden");
    const candidate = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const response = await fetch("https://shell.online/api/health", { signal: AbortSignal.timeout(10000), cache: "no-store" });
    if (!response.ok) throw new Error("live version unavailable");
    assertReleaseVersion(candidate, (await response.json()).version);
    process.exitCode = deployProduction();
  } catch {
    console.error("Production deployment refused: verify release version (no downgrade), private target config and arguments.");
    process.exitCode = 1;
  }
}
