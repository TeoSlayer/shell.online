import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The deploy guard: a production Wrangler config must route at least the
 * paths the example routes through the Worker, or their pages are never
 * counted. It reads JSONC, so comments and trailing commas must not trip it,
 * and a string holding "//" must not be taken for a comment.
 */
const script = fileURLToPath(new URL("../scripts/check-worker-routing.mjs", import.meta.url));

const REFERENCE = `{
  // the example config, with everything JSONC allows
  "name": "shell-online", /* block comment */
  "routes": [{ "pattern": "https://shell.online/*", "custom_domain": true }],
  "assets": {
    "run_worker_first": [
      "/api/*",
      "/docs/*",
      "/app/*",
    ],
  },
}
`;

function guard(reference: string, deployment: string): { status: number | null; stdout: string; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "worker-routing-"));
  const referencePath = join(directory, "reference.jsonc");
  const deploymentPath = join(directory, "deployment.jsonc");
  writeFileSync(referencePath, reference);
  writeFileSync(deploymentPath, deployment);
  const result = spawnSync(process.execPath, [script, referencePath, deploymentPath], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the Worker routing guard", () => {
  it("accepts a deployment that routes everything the reference routes, comments and all", () => {
    const result = guard(REFERENCE, REFERENCE.replace('"/api/*",', '"/api/*", "/extra/*",'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("routes every counted path through the Worker");
  });

  it("refuses a deployment missing a path, and names it", () => {
    const result = guard(REFERENCE, REFERENCE.replace('      "/app/*",\n', ""));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("/app/*");
    expect(result.stderr).toContain("would never be counted");
  });

  it("accepts a deployment that runs the Worker first for everything", () => {
    const result = guard(REFERENCE, '{ "assets": { "run_worker_first": true } }');
    expect(result.status).toBe(0);
  });

  it("refuses a config it cannot read, and a config without the list", () => {
    expect(guard(REFERENCE, "{ not json").status).toBe(1);
    expect(guard(REFERENCE, '{ "assets": { "run_worker_first": "/api/*" } }').status).toBe(1);
    expect(guard(REFERENCE, "{}").status).toBe(1);
  });

  it("wants two paths", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});
