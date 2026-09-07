import { describe, expect, it } from "vitest";
import { machineOnline } from "./agent";

const NOW = 1_000_000;

describe("machineOnline", () => {
  it("is false for a machine that has never run an agent", () => {
    expect(machineOnline({}, NOW)).toBe(false);
    expect(machineOnline({ agentSeenAt: undefined }, NOW)).toBe(false);
  });

  it("is true while the agent is polling", () => {
    expect(machineOnline({ agentSeenAt: NOW }, NOW)).toBe(true);
    expect(machineOnline({ agentSeenAt: NOW - 14_000 }, NOW)).toBe(true);
  });

  it("goes false once polling stops", () => {
    /* This is what makes the Start button honest about a dead agent. */
    expect(machineOnline({ agentSeenAt: NOW - 16_000 }, NOW)).toBe(false);
    expect(machineOnline({ agentSeenAt: NOW - 600_000 }, NOW)).toBe(false);
  });

  it("ignores a nonsense timestamp rather than reading as online", () => {
    expect(machineOnline({ agentSeenAt: Number.NaN }, NOW)).toBe(false);
  });
});
