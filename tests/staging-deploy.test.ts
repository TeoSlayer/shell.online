import { describe, expect, it, vi, afterEach } from "vitest";
// The staging deployment wrapper: it owns every wrangler flag, so arguments forwarded through
// `npm run deploy:staging -- …` can no longer override the validated --config/--env-file/target.
// Tests run a STUBBED executor — no real deployment, no wrangler process.
// @ts-expect-error - .mjs module has no type declarations in the Workers type surface
import { deployStaging, stagingDeployArgv, validateDeployArgs, STAGING_CONFIG, STAGING_ENV_FILE } from "../scripts/deploy-staging.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FLAG = "enable_request_signal";
const SECRET = "SECRET-ACCOUNT-0123456789abcdef";

function makeConfigDir(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-staging-"));
  writeFileSync(join(dir, "wrangler.staging.jsonc"), text);
  return dir;
}

function validConfig(): string {
  return `{\n  "name": "shell-online-staging",\n  "compatibility_flags": ["${FLAG}"]\n}\n`;
}

type Stub = { calls: Array<string[]>; status: number };
function makeStub(status = 0): Stub {
  return { calls: [], status };
}
function stubExecutor(stub: Stub) {
  return (argv: string[]) => {
    stub.calls.push(argv);
    return stub.status;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("staging deploy wrapper", () => {
  it("builds the fixed wrangler argv (config, env file, target all owned by the wrapper)", () => {
    expect(stagingDeployArgv()).toEqual([
      "deploy",
      "--config",
      resolve(STAGING_CONFIG),
      "--env-file",
      STAGING_ENV_FILE,
    ]);
  });

  it("builds the argv around the exact config path the preflight validated", () => {
    const custom = "/tmp/somewhere/wrangler.staging.jsonc";
    expect(stagingDeployArgv(custom)).toEqual(["deploy", "--config", custom, "--env-file", STAGING_ENV_FILE]);
  });

  it("rejects every caller-supplied argument as an unsafe override, without echoing it", () => {
    expect(validateDeployArgs([])).toEqual({ ok: true });
    for (const argv of [
      ["--config", "wrangler.production.jsonc"],
      ["--env-file", ".dev.vars.production"],
      ["--dry-run"],
      ["extra"],
    ]) {
      const check = validateDeployArgs(argv);
      expect(check.ok).toBe(false);
      // The rejected arguments are NOT echoed: a forwarded value may be a credential, and the
      // error message is printed to the terminal.
      for (const value of argv) {
        expect(check.error).not.toContain(value);
      }
    }
  });

  it("redaction: a rejected argument carrying a credential never appears in the error", () => {
    const check = validateDeployArgs(["--var", `API_TOKEN=${SECRET}`, "--config", "wrangler.production.jsonc"]);
    expect(check.ok).toBe(false);
    expect(check.error).not.toContain(SECRET);
    expect(check.error).not.toContain(`API_TOKEN=${SECRET}`);
  });

  it("deploys with the fixed argv after a passing preflight (stubbed executor)", async () => {
    const dir = makeConfigDir(validConfig());
    const stub = makeStub(0);
    const order: string[] = [];
    const executor = (argv: string[]) => {
      order.push("executor");
      return stubExecutor(stub)(argv);
    };
    try {
      const configPath = join(dir, "wrangler.staging.jsonc");
      const status = await deployStaging({
        configPath,
        executor,
      });
      order.push("done");
      expect(status).toBe(0);
      // The executor deploys the SAME resolved config path the preflight validated — no second,
      // unvalidated default.
      expect(stub.calls).toEqual([["deploy", "--config", configPath, "--env-file", STAGING_ENV_FILE]]);
      expect(order).toEqual(["executor", "done"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards no caller arguments to wrangler, even when supplied", async () => {
    const dir = makeConfigDir(validConfig());
    const stub = makeStub(0);
    try {
      const status = await deployStaging({
        configPath: join(dir, "wrangler.staging.jsonc"),
        executor: stubExecutor(stub),
        argv: ["--config", "wrangler.production.jsonc"],
      });
      expect(status).toBe(2);
      expect(stub.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not run the executor when the config lacks the required flag", async () => {
    const dir = makeConfigDir(`{\n  "name": "shell-online-staging",\n  "compatibility_flags": []\n}\n`);
    const stub = makeStub(0);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const status = await deployStaging({
        configPath: join(dir, "wrangler.staging.jsonc"),
        executor: stubExecutor(stub),
      });
      expect(status).toBe(1);
      expect(stub.calls).toEqual([]);
      expect(err).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not run the executor when the config file is missing", async () => {
    const dir = makeConfigDir(validConfig());
    rmSync(join(dir, "wrangler.staging.jsonc"));
    const stub = makeStub(0);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const status = await deployStaging({
        configPath: join(dir, "wrangler.staging.jsonc"),
        executor: stubExecutor(stub),
      });
      expect(status).toBe(1);
      expect(stub.calls).toEqual([]);
      expect(err).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates executor failure as the exit status", async () => {
    const dir = makeConfigDir(validConfig());
    const stub = makeStub(1);
    try {
      const status = await deployStaging({
        configPath: join(dir, "wrangler.staging.jsonc"),
        executor: stubExecutor(stub),
      });
      expect(status).toBe(1);
      expect(stub.calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redaction: preflight failure output never contains config content", async () => {
    const dir = makeConfigDir(`{"${SECRET}": 1/*gap*/2, "compatibility_flags": ["${FLAG}"]}`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const status = await deployStaging({
        configPath: join(dir, "wrangler.staging.jsonc"),
        executor: stubExecutor(makeStub(0)),
      });
      expect(status).toBe(1);
      for (const call of [...err.mock.calls, ...log.mock.calls]) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(SECRET);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
