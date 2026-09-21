import { vi } from "vitest";

// Freeze only the authorization clock until the real request/model is admitted.
// Keep real timers: expiry retirement must happen through the scheduled callback,
// not through another MCP request or a direct call to the retirement helper.
export async function withGrantClock(
  test: (expire: (ttlSeconds: number) => void) => Promise<void>,
): Promise<void> {
  const issuedAt = Math.floor(Date.now() / 1000) * 1000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(issuedAt);
  try {
    await test((ttlSeconds) => vi.setSystemTime(issuedAt + ttlSeconds * 1000 + 1));
  } finally {
    vi.useRealTimers();
  }
}
