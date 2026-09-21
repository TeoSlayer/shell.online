import { describe, expect, it } from "vitest";
import { automationConsent, canManageAutomation } from "./session-automation";

describe("session automation consent", () => {
  it("defaults every independent switch off", () => {
    expect(automationConsent({})).toEqual({ mcpTeamAccess: false, dailyBriefingEnabled: false, dailyBriefingTeamAccess: false });
    expect(automationConsent({ mcpTeamAccess: true })).toEqual({ mcpTeamAccess: true, dailyBriefingEnabled: false, dailyBriefingTeamAccess: false });
  });
  it("never coerces a truthy value to permission", () => {
    expect(automationConsent({ mcpTeamAccess: "true" } as never).mcpTeamAccess).toBe(false);
  });
  it("uses only ownership, with a fallback for legacy sessions", () => {
    expect(canManageAutomation({ ownerUid: "a" }, { uid: "a" })).toBe(true);
    expect(canManageAutomation({ ownerUid: "a", uid: "b" }, { uid: "b" })).toBe(false);
    expect(canManageAutomation({ uid: "a" }, { uid: "a" })).toBe(true);
    expect(canManageAutomation({}, { uid: "a" })).toBe(false);
    expect(canManageAutomation({}, null)).toBe(false);
  });
});
