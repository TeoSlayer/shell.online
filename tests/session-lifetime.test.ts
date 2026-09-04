import { describe, expect, it } from "vitest";
import {
  disconnectedSessionExpiry,
  PERSISTENT_TTL_MS,
  SESSION_TTL_MS,
} from "../shared/session-lifetime";

describe("disconnected session lifetime", () => {
  it("keeps an ordinary share recoverable for twelve hours", () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    expect(disconnectedSessionExpiry(now, false)).toBe(now + SESSION_TTL_MS);
  });

  it("retains the persistent thirty-day recovery window", () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    expect(disconnectedSessionExpiry(now, true)).toBe(now + PERSISTENT_TTL_MS);
  });
});
