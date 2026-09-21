import { describe, expect, it } from "vitest";
import {
  clampLifetime,
  createGrantRecord,
  hasScope,
  isLive,
  liveCount,
  MAX_GRANTS_PER_RUN,
  sanitizeLabel,
  scopeSetKey,
  validateScopes,
  type McpGrantRecord,
} from "../shared/mcp-grants";

const NOW = 1_700_000_000;
const RUN = "run-42";

describe("mcp-grants", () => {
  describe("scope validation", () => {
    it("accepts the three valid presets and canonicalizes (dedupe + sort)", () => {
      expect(validateScopes(["observe"])).toEqual(["observe"]);
      expect(validateScopes(["input", "observe"])).toEqual(["input", "observe"]);
      expect(validateScopes(["interrupt", "observe", "input", "observe"])).toEqual([
        "input",
        "interrupt",
        "observe",
      ]);
    });

    it("enforces that input implies observe", () => {
      expect(() => validateScopes(["input"])).toThrow(/invalid scope set/);
    });

    it("rejects interrupt without input (only the three presets are valid)", () => {
      expect(() => validateScopes(["observe", "interrupt"])).toThrow(/invalid scope set/);
    });

    it("rejects an unknown scope", () => {
      expect(() => validateScopes(["observe", "write"] as never)).toThrow(/unknown scope/);
    });
  });

  describe("scopeSetKey", () => {
    it("maps each preset to its name", () => {
      expect(scopeSetKey(["observe"])).toBe("observe");
      expect(scopeSetKey(["input", "observe"])).toBe("control");
      expect(scopeSetKey(["input", "interrupt", "observe"])).toBe("controlInterrupt");
      expect(scopeSetKey(["input"])).toBeNull();
    });
  });

  describe("clampLifetime", () => {
    const ceiling = NOW + 100 * 3600; // run/session lives for 100h from now

    it("uses the preset default when no lifetime is requested", () => {
      expect(clampLifetime(null, ["observe"], NOW, ceiling)).toBe(3600);
      expect(clampLifetime(null, ["input", "observe"], NOW, ceiling)).toBe(900);
    });

    it("clamps a requested lifetime to the preset hard maximum", () => {
      expect(clampLifetime(999999, ["observe"], NOW, ceiling)).toBe(12 * 3600);
      expect(clampLifetime(999999, ["input", "observe"], NOW, ceiling)).toBe(3600);
    });

    it("never lets a grant outlive the run/session ceiling", () => {
      // Run ends in 10 minutes; an observe grant (default 1h) is clamped to 10 minutes.
      const shortCeiling = NOW + 600;
      expect(clampLifetime(null, ["observe"], NOW, shortCeiling)).toBe(600);
      expect(clampLifetime(3600, ["input", "observe"], NOW, shortCeiling)).toBe(600);
    });

    it("clamps a sub-second request up to 1 second", () => {
      expect(clampLifetime(0.2, ["observe"], NOW, ceiling)).toBe(1);
    });

    it("throws when the run/session has already expired", () => {
      expect(() => clampLifetime(null, ["observe"], NOW, NOW)).toThrow(/already expired/);
    });
  });

  describe("sanitizeLabel", () => {
    it("strips control chars, trims, and bounds the length", () => {
      expect(sanitizeLabel("  codex \x01\x02 agent ")).toBe("codex agent");
      expect(sanitizeLabel("x".repeat(100))).toHaveLength(64);
      expect(sanitizeLabel("\u007fDEL\u0000NUL")).toBe("DELNUL");
    });
  });

  describe("liveness + scopes", () => {
    const rec: McpGrantRecord = {
      grantId: "g1",
      bearerHash: "abc",
      label: "codex",
      scopes: ["input", "observe"],
      runId: RUN,
      createdAt: NOW,
      expiresAt: NOW + 600,
      revoked: false,
      revokedAt: null,
    };

    it("isLive is true before expiry, false after, and false once revoked", () => {
      expect(isLive(rec, NOW + 10)).toBe(true);
      expect(isLive(rec, NOW + 601)).toBe(false);
      expect(isLive({ ...rec, revoked: true, revokedAt: NOW }, NOW + 10)).toBe(false);
    });

    it("hasScope reflects the grant's scope set", () => {
      expect(hasScope(rec, "observe")).toBe(true);
      expect(hasScope(rec, "input")).toBe(true);
      expect(hasScope(rec, "interrupt")).toBe(false);
    });
  });

  describe("liveCount", () => {
    it("counts only live grants for the given run", () => {
      const grants = [
        { grantId: "a", runId: RUN, revoked: false, expiresAt: NOW + 100 } as McpGrantRecord,
        { grantId: "b", runId: RUN, revoked: true, expiresAt: NOW + 100 } as McpGrantRecord,
        { grantId: "c", runId: RUN, revoked: false, expiresAt: NOW - 1 } as McpGrantRecord,
        { grantId: "d", runId: "other", revoked: false, expiresAt: NOW + 100 } as McpGrantRecord,
      ];
      expect(liveCount(grants, RUN, NOW)).toBe(1);
    });
  });

  describe("createGrantRecord", () => {
    it("builds a record with canonical scopes, sanitized label, and computed expiry", () => {
      const rec = createGrantRecord({
        grantId: "g1",
        bearerHash: "deadbeef",
        label: "  codex \x01 ",
        scopes: ["observe", "input"],
        runId: RUN,
        now: NOW,
        lifetime: 900,
      });
      expect(rec.scopes).toEqual(["input", "observe"]);
      expect(rec.label).toBe("codex");
      expect(rec.createdAt).toBe(NOW);
      expect(rec.expiresAt).toBe(NOW + 900);
      expect(rec.revoked).toBe(false);
      expect(rec.revokedAt).toBeNull();
    });

    it("rejects an invalid scope set and a non-positive lifetime", () => {
      expect(() =>
        createGrantRecord({
          grantId: "g1", bearerHash: "h", label: "l", scopes: ["input"],
          runId: RUN, now: NOW, lifetime: 900,
        }),
      ).toThrow(/invalid scope set/);
      expect(() =>
        createGrantRecord({
          grantId: "g1", bearerHash: "h", label: "l", scopes: ["observe"],
          runId: RUN, now: NOW, lifetime: 0,
        }),
      ).toThrow(/lifetime/);
    });
  });

  it("exposes the max-live-grants-per-run constant", () => {
    expect(MAX_GRANTS_PER_RUN).toBe(8);
  });
});
