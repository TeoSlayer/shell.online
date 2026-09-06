import { describe, expect, it } from "vitest";
import { agentOnline } from "./agent";

const NOW = 1_000_000;

describe("agentOnline", () => {
  it("is false for a machine that has never run an agent", () => {
    expect(agentOnline({}, NOW)).toBe(false);
    expect(agentOnline({ agentSeenAt: undefined }, NOW)).toBe(false);
  });

  it("is true while the agent is polling", () => {
    expect(agentOnline({ agentSeenAt: NOW }, NOW)).toBe(true);
    expect(agentOnline({ agentSeenAt: NOW - 14_000 }, NOW)).toBe(true);
  });

  it("goes false once polling stops", () => {
    /* This is what makes the Start button honest about a dead agent. */
    expect(agentOnline({ agentSeenAt: NOW - 16_000 }, NOW)).toBe(false);
    expect(agentOnline({ agentSeenAt: NOW - 600_000 }, NOW)).toBe(false);
  });

  it("ignores a nonsense timestamp rather than reading as online", () => {
    expect(agentOnline({ agentSeenAt: Number.NaN }, NOW)).toBe(false);
  });
});
