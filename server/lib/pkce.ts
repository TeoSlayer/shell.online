import { createHash, timingSafeEqual } from "node:crypto";

export function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** S256: challenge = base64url(sha256(verifier)). */
export function deriveChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/**
 * RFC 7636 restricts the verifier to 43-128 unreserved characters. Anything
 * shorter is brute-forceable, so a short verifier is rejected outright rather
 * than quietly accepted.
 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

export function verifyChallenge(verifier: string, challenge: string): boolean {
  if (!isValidVerifier(verifier)) return false;
  const expected = Buffer.from(deriveChallenge(verifier));
  const actual = Buffer.from(challenge);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
