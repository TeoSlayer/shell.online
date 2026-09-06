import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { base64url, deriveChallenge, isValidVerifier, verifyChallenge } from "./pkce";

const validVerifier = base64url(randomBytes(48));

describe("base64url", () => {
  it("emits no padding or url-unsafe characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const encoded = base64url(randomBytes(32));
      expect(encoded).not.toMatch(/[+/=]/);
    }
  });
});

describe("isValidVerifier", () => {
  it("accepts a 43 to 128 character unreserved string", () => {
    expect(isValidVerifier("a".repeat(43))).toBe(true);
    expect(isValidVerifier("a".repeat(128))).toBe(true);
    expect(isValidVerifier(validVerifier)).toBe(true);
  });

  it("rejects a verifier short enough to brute force", () => {
    expect(isValidVerifier("a".repeat(42))).toBe(false);
    expect(isValidVerifier("")).toBe(false);
  });

  it("rejects an over-long verifier", () => {
    expect(isValidVerifier("a".repeat(129))).toBe(false);
  });

  it("rejects reserved characters", () => {
    expect(isValidVerifier(`${"a".repeat(42)}/`)).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidVerifier(`${"a".repeat(42)} `)).toBe(false);
  });
});

describe("deriveChallenge", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    /* The verifier and expected challenge are given verbatim in the RFC. */
    expect(deriveChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("is deterministic and 43 characters", () => {
    const challenge = deriveChallenge(validVerifier);
    expect(challenge).toHaveLength(43);
    expect(deriveChallenge(validVerifier)).toBe(challenge);
  });
});

describe("verifyChallenge", () => {
  it("accepts the matching verifier", () => {
    expect(verifyChallenge(validVerifier, deriveChallenge(validVerifier))).toBe(true);
  });

  it("rejects a different verifier", () => {
    const other = base64url(randomBytes(48));
    expect(verifyChallenge(other, deriveChallenge(validVerifier))).toBe(false);
  });

  it("rejects an invalid verifier even when the challenge would match", () => {
    const short = "abc";
    expect(verifyChallenge(short, deriveChallenge(short))).toBe(false);
  });

  it("rejects a truncated challenge without throwing", () => {
    const challenge = deriveChallenge(validVerifier);
    expect(verifyChallenge(validVerifier, challenge.slice(0, 20))).toBe(false);
    expect(verifyChallenge(validVerifier, "")).toBe(false);
  });
});
