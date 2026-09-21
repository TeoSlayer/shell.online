import { describe, expect, it } from "vitest";
// Parsed-JSONC config-contract validation, shared with the staging deployment preflight. The
// module is plain ESM (.mjs); vitest resolves it in the Node runtime.
// @ts-expect-error - .mjs module has no type declarations in the Workers type surface
import { parseJsonc, assertCompatibilityFlags, validateConfigFile, REQUIRED_COMPATIBILITY_FLAGS } from "../scripts/wrangler-config-contract.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLAG = "enable_request_signal";
// A marker that stands in for private config content (account id, keys). It must never appear in
// an error message: parser diagnostics embed input excerpts, so only fixed messages may surface.
const SECRET = "SECRET-ACCOUNT-0123456789abcdef";

function writeTempConfig(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wrangler-contract-"));
  const path = join(dir, "wrangler.staging.jsonc");
  writeFileSync(path, text);
  return path;
}

describe("wrangler config contract: parsed-JSONC validation", () => {
  it("accepts the tracked secret-free contract fixture", () => {
    expect(() => validateConfigFile("tests/fixtures/wrangler.staging.contract.jsonc")).not.toThrow();
    expect(REQUIRED_COMPATIBILITY_FLAGS).toContain(FLAG);
  });

  it("accepts a config that carries the required flag", () => {
    const path = writeTempConfig(`{\n  "name": "shell-online-staging",\n  "compatibility_flags": ["${FLAG}"]\n}\n`);
    try {
      expect(() => validateConfigFile(path)).not.toThrow();
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("accepts trailing commas (Wrangler JSONC behavior)", () => {
    const value = parseJsonc(`{"compatibility_flags": ["${FLAG}",],}`);
    expect(value.compatibility_flags).toEqual([FLAG]);
  });

  it("keeps // and /* */ inside string literals intact", () => {
    const value = parseJsonc(`{"url": "https://shell.online/*keep*/x", // ${FLAG}
      "compatibility_flags": ["${FLAG}"]}`);
    expect(value.url).toBe("https://shell.online/*keep*/x");
    expect(value.compatibility_flags).toEqual([FLAG]);
  });

  it("rejects a config missing the required flag", () => {
    expect(() => assertCompatibilityFlags({ compatibility_flags: ["something_else"] })).toThrow(
      `compatibility_flags is missing required flag(s): ${FLAG}`,
    );
  });

  it("rejects a config without a compatibility_flags array", () => {
    expect(() => assertCompatibilityFlags({})).toThrow("compatibility_flags is missing or not an array");
    expect(() => assertCompatibilityFlags({ compatibility_flags: FLAG })).toThrow(
      "compatibility_flags is missing or not an array",
    );
  });

  it("rejects a flag buried in a comment", () => {
    const path = writeTempConfig(`{\n  // ${FLAG}\n  /* ${FLAG} */\n  "compatibility_flags": []\n}\n`);
    try {
      expect(() => validateConfigFile(path)).toThrow(`missing required flag(s): ${FLAG}`);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("rejects a flag in an unrelated field", () => {
    expect(() => assertCompatibilityFlags({ other_field: FLAG, compatibility_flags: [] })).toThrow(
      `missing required flag(s): ${FLAG}`,
    );
  });

  it("rejects an unterminated block comment with a fixed message", () => {
    expect(() => parseJsonc(`{"compatibility_flags": ["${FLAG}"], /* oops`)).toThrow("config is not valid JSONC");
  });

  it("rejects malformed JSON with a fixed message", () => {
    expect(() => parseJsonc(`{"compatibility_flags": [${FLAG}]}`)).toThrow("config is not valid JSONC");
  });

  it("regression: a block comment between tokens is a parse error, not token concatenation", () => {
    // The old hand-rolled stripper deleted /*gap*/ without a separator, so 1/*gap*/2 parsed as 12.
    // Wrangler's own parser (jsonc-parser) rejects it; the contract must agree.
    expect(() => parseJsonc(`{"x": 1/*gap*/2}`)).toThrow("config is not valid JSONC");
    // A comment between tokens that ARE separated parses fine.
    expect(parseJsonc(`{"x": 1 /*gap*/ , "y": 2}`).x).toBe(1);
  });

  it("rejects a missing config file naming only the path", () => {
    expect(() => validateConfigFile("/nonexistent/wrangler.staging.jsonc")).toThrow(
      "config file not found: /nonexistent/wrangler.staging.jsonc",
    );
  });

  it("redaction: no error message ever contains config content", () => {
    const cases: Array<[string, () => unknown]> = [
      [`{"${SECRET}": 1/*gap*/2}`, () => parseJsonc(`{"${SECRET}": 1/*gap*/2}`)],
      [`{"${SECRET}": }`, () => parseJsonc(`{"${SECRET}": }`)],
      [`{"${SECRET}": [/*`, () => parseJsonc(`{"${SECRET}": [/*`)],
      [`not json at all ${SECRET}`, () => parseJsonc(`not json at all ${SECRET}`)],
    ];
    for (const [source, fail] of cases) {
      expect(source).toBeTruthy();
      try {
        fail();
        throw new Error("expected parseJsonc to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("config is not valid JSONC");
        expect((err as Error).message).not.toContain(SECRET);
      }
    }
  });

  it("redaction: validateConfigFile errors never contain config content", () => {
    const path = writeTempConfig(`{"${SECRET}": 1/*gap*/2, "compatibility_flags": ["${FLAG}"]}`);
    try {
      try {
        validateConfigFile(path);
        throw new Error("expected validateConfigFile to throw");
      } catch (err) {
        expect((err as Error).message).toBe("config is not valid JSONC");
        expect((err as Error).message).not.toContain(SECRET);
      }
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});
