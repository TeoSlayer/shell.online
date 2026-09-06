import { describe, expect, it } from "vitest";
import {
  accountCookie,
  clearedAccountCookie,
  createAccountSession,
  hashPassword,
  normalizeEmail,
  readAccountSession,
  validatePassword,
  verifyPassword,
} from "../worker/account-auth";

const SECRET = "an-account-signing-secret";

describe("account passwords", () => {
  it("derives a distinct salt and hash for the same password", async () => {
    const first = await hashPassword("correct horse battery");
    const second = await hashPassword("correct horse battery");
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });

  it("verifies a password against its own salt", async () => {
    const { salt, hash } = await hashPassword("correct horse battery");
    await expect(verifyPassword("correct horse battery", salt, hash)).resolves.toBe(true);
  });

  it("rejects the wrong password and a mismatched salt", async () => {
    const { salt, hash } = await hashPassword("correct horse battery");
    const other = await hashPassword("correct horse battery");
    await expect(verifyPassword("wrong password", salt, hash)).resolves.toBe(false);
    await expect(verifyPassword("correct horse battery", other.salt, hash)).resolves.toBe(false);
  });

  it("never stores the password itself", async () => {
    const { salt, hash } = await hashPassword("correct horse battery");
    expect(salt).not.toContain("correct");
    expect(hash).not.toContain("correct");
  });
});

describe("account session tokens", () => {
  it("round-trips the account id", async () => {
    const token = await createAccountSession("account-1", SECRET);
    await expect(readAccountSession(token, SECRET)).resolves.toBe("account-1");
  });

  it("refuses a token signed with a different secret", async () => {
    const token = await createAccountSession("account-1", SECRET);
    await expect(readAccountSession(token, "a-completely-other-secret")).resolves.toBeNull();
  });

  it("refuses a tampered payload", async () => {
    const token = await createAccountSession("account-1", SECRET);
    const [version, , signature] = token.split(".");
    const forged = btoa(JSON.stringify({ accountId: "account-2", issuedAt: 0, expiresAt: Date.now() + 1000 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    await expect(readAccountSession(`${version}.${forged}.${signature}`, SECRET)).resolves.toBeNull();
  });

  it("refuses an expired token", async () => {
    const issued = Date.now() - 400 * 24 * 60 * 60 * 1000;
    const token = await createAccountSession("account-1", SECRET, issued);
    await expect(readAccountSession(token, SECRET)).resolves.toBeNull();
  });

  it("refuses malformed input and weak secrets", async () => {
    await expect(readAccountSession(null, SECRET)).resolves.toBeNull();
    await expect(readAccountSession("not-a-token", SECRET)).resolves.toBeNull();
    const token = await createAccountSession("account-1", SECRET);
    await expect(readAccountSession(token, "tooshort")).resolves.toBeNull();
  });
});

describe("account cookies", () => {
  it("marks the session cookie as HttpOnly and SameSite=Strict", () => {
    const cookie = accountCookie("token-value", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
  });

  it("omits Secure when the origin is not https", () => {
    expect(accountCookie("token-value", false)).not.toContain("Secure");
  });

  it("expires the cookie when signing out", () => {
    expect(clearedAccountCookie(true)).toContain("Max-Age=0");
  });
});

describe("account input validation", () => {
  it("normalises usable addresses", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("rejects addresses that are not addresses", () => {
    for (const value of ["", "nope", "a@b", "no spaces@example.com", 42, null]) {
      expect(normalizeEmail(value)).toBeNull();
    }
  });

  it("requires at least eight characters of password", () => {
    expect(validatePassword("shortie")).toBeNull();
    expect(validatePassword("just-long-enough")).toBe("just-long-enough");
    expect(validatePassword("x".repeat(257))).toBeNull();
    expect(validatePassword(undefined)).toBeNull();
  });
});
