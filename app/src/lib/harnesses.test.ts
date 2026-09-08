import { describe, expect, it } from "vitest";
import { harnessMissing } from "./harnesses";

describe("harnessMissing", () => {
  it("says nothing about a machine that has never reported", () => {
    /* The interesting case: unknown must not be rendered as absent. */
    expect(harnessMissing("claude-code", {})).toBe(false);
    expect(harnessMissing("claude-code", undefined)).toBe(false);
    expect(harnessMissing("claude-code", { harnesses: undefined })).toBe(false);
  });

  it("is quiet when the machine reported the tool", () => {
    expect(harnessMissing("claude-code", { harnesses: ["claude-code", "codex"] })).toBe(false);
  });

  it("warns when the machine reported and the tool was not among them", () => {
    expect(harnessMissing("codex", { harnesses: ["claude-code"] })).toBe(true);
  });

  it("treats a report of none as a report", () => {
    expect(harnessMissing("hermes", { harnesses: [] })).toBe(true);
  });

  it("never warns about a kind the agent does not look for", () => {
    /* A terminal process is any command at all; there is nothing to detect. */
    expect(harnessMissing("terminal", { harnesses: [] })).toBe(false);
    expect(harnessMissing("terminal", { harnesses: ["claude-code"] })).toBe(false);
  });

  it("matches on the exact id", () => {
    expect(harnessMissing("openclaw", { harnesses: ["openclaw"] })).toBe(false);
    expect(harnessMissing("openclaw", { harnesses: ["OpenClaw"] })).toBe(true);
    expect(harnessMissing("openclaw", { harnesses: ["openclaw-gateway"] })).toBe(true);
  });
});
