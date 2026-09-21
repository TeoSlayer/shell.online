import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
// @ts-expect-error The shared deploy script is exercised directly as JavaScript.
import { validateProductionConfig, deployProduction, assertReleaseVersion } from "../scripts/deploy-production.mjs";

const valid = () => ({
  name: "shell-online", account_id: "a".repeat(32),
  compatibility_flags: ["enable_request_signal"],
  routes: [{ pattern: "shell.online" }, { pattern: "stats.shell.online" }],
  vars: { MCP_CONTROL_ENABLED: "0" },
});
describe("production deploy guard", () => {
  it("refuses an older or unknown release identity", () => {
    expect(() => assertReleaseVersion("0.7.3", "0.20.0")).toThrow("downgrade");
    expect(() => assertReleaseVersion("0.8.0", "0.20.0")).toThrow("downgrade");
    expect(() => assertReleaseVersion("0.21.0", "0.20.0")).not.toThrow();
    expect(() => assertReleaseVersion("0.20.0", "0.20.0")).not.toThrow();
    expect(() => assertReleaseVersion("0.21.0", undefined)).toThrow();
  });
  it("accepts the explicit production target with either control state", () => {
    expect(() => validateProductionConfig(valid())).not.toThrow();
    expect(() => validateProductionConfig({ ...valid(), vars: { MCP_CONTROL_ENABLED: "1" } })).not.toThrow();
  });
  it.each([
    { name: "shell-online-staging" }, { account_id: undefined }, { routes: [] },
    { compatibility_flags: [] }, { vars: {} },
    { vars: { MCP_CONTROL_ENABLED: "1", MCP_STAGING_HOSTNAMES: "[]" } },
  ])("rejects unsafe topology or missing gate", (change) => {
    expect(() => validateProductionConfig({ ...valid(), ...change })).toThrow();
  });
  it("rejects extra flags before reading config or executing", () => {
    let invoked = false;
    expect(() => deployProduction({ argv: ["--config", "SECRET"], executor: () => { invoked = true; } })).toThrow("does not accept");
    expect(invoked).toBe(false);
  });

  it("runs upstream's complete release pipeline with the exact validated config", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-production-guard-"));
    try {
      const configPath = join(dir, "production.jsonc");
      writeFileSync(configPath, JSON.stringify(valid()), { mode: 0o600 });
      let calls = 0;
      expect(deployProduction({ configPath, executor: (args: string[], options: { env: Record<string, string> }) => {
        calls++;
        expect(args).toHaveLength(1);
        expect(isAbsolute(args[0])).toBe(true);
        expect(args[0]).toMatch(/scripts\/deploy-production\.sh$/);
        expect(options.env.SHELL_ONLINE_WRANGLER_CONFIG).toBe(configPath);
        return 0;
      } })).toBe(0);
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
