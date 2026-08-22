import { describe, expect, it } from "vitest";
import {
  clearStatsSessionCookie,
  createStatsSession,
  createStatsSessionCookie,
  readStatsSessionCookie,
  verifyStatsPassword,
  verifyStatsSession,
} from "../worker/stats-auth";

const PASSWORD = "local-test-password-with-enough-entropy";

describe("statistics password authentication", () => {
  it("accepts only the configured password", async () => {
    await expect(verifyStatsPassword(PASSWORD, PASSWORD)).resolves.toBe(true);
    await expect(verifyStatsPassword("wrong password", PASSWORD)).resolves.toBe(false);
    await expect(verifyStatsPassword("", PASSWORD)).resolves.toBe(false);
  });

  it("signs expiring sessions and rejects tampering", async () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const token = await createStatsSession(PASSWORD, now);

    await expect(verifyStatsSession(token, PASSWORD, now + 1_000)).resolves.toBe(true);
    await expect(verifyStatsSession(token, "another-long-password", now + 1_000))
      .resolves.toBe(false);
    const tamperedAt = Math.floor(token.length / 2);
    const replacement = token[tamperedAt] === "x" ? "y" : "x";
    const tampered = `${token.slice(0, tamperedAt)}${replacement}${token.slice(tamperedAt + 1)}`;
    await expect(verifyStatsSession(tampered, PASSWORD, now + 1_000))
      .resolves.toBe(false);
    await expect(verifyStatsSession(token, PASSWORD, now + 24 * 60 * 60 * 1_000))
      .resolves.toBe(false);
  });

  it("uses a private same-site cookie and can clear it", async () => {
    const token = await createStatsSession(PASSWORD);
    const cookie = createStatsSessionCookie(token, true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(readStatsSessionCookie(new Request("https://stats.shell.online", {
      headers: { Cookie: `unrelated=1; ${cookie.split(";")[0]}` },
    }))).toBe(token);
    expect(clearStatsSessionCookie(true)).toContain("Max-Age=0");
  });
});
