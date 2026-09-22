import { describe, expect, it } from "vitest";
import { sessionConnectionLabel } from "../web/session-status";

describe("shared viewer connection wording", () => {
  it("does not describe a connected socket as offline while measuring latency", () => {
    expect(sessionConnectionLabel("connected", false, null)).toBe("Connected");
    expect(sessionConnectionLabel("connected", false, 42)).toBe("Connected · 42 ms");
  });
  it.each([
    ["connecting", "Connecting…"], ["waiting", "Waiting for host"],
    ["full", "Full · waiting"], ["exited", "Session ended"],
    ["missing", "Link unavailable"], ["disconnected", "Reconnecting…"],
  ])("explains %s", (state, expected) => expect(sessionConnectionLabel(state, false, null)).toBe(expected));
  it("explains why an encrypted viewer has not connected", () => {
    expect(sessionConnectionLabel("connecting", true, null)).toBe("Password needed");
  });
});
