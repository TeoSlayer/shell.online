import { describe, expect, it } from "vitest";
import { persistentSessionID } from "../shared/persistent-session";

describe("persistent session identity", () => {
  it("matches the Go host-token binding vector", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    expect(await persistentSessionID(token)).toBe("EkMXVp1uVpwCpBHQHlMNIj-AVjpR2hr3");
    expect(await persistentSessionID(`${token}x`)).not.toBe(await persistentSessionID(token));
  });
});
