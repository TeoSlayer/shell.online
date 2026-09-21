import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionPulseBadge, sessionPulsePresentation } from "./SessionPulse";
import type { SessionPulse } from "./session-pulse";

const pulse: SessionPulse = {
  activity: "unobserved", lastOutputAt: null, bytesSinceViewed: 0, hint: null,
};

describe("session pulse badge", () => {
  it.each([
    ["unobserved", "Not observed"], ["output", "Output active"], ["quiet", "Quiet"],
  ] as const)("describes %s without claiming an agent state", (activity, label) => {
    const html = renderToStaticMarkup(createElement(SessionPulseBadge, { pulse: { ...pulse, activity } }));
    expect(html).toContain(label);
    expect(html).toContain("does not establish whether an agent is idle or finished");
    expect(html).toContain('role="img"');
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="status"');
  });

  it("never reflects an unknown hint label or raw terminal text", () => {
    const html = renderToStaticMarkup(createElement(SessionPulseBadge, {
      pulse: { ...pulse, hint: { kind: "attention", label: "secret terminal output" } }, compact: true,
    }));
    expect(html).not.toContain("session-pulse__hint");
    expect(html).not.toContain("secret terminal output");
    expect(html).toContain("session-pulse--compact");
    expect(sessionPulsePresentation({ ...pulse, hint: { kind: "result", label: "done" } }).hint).toBeNull();
  });

  it.each([
    ["attention", "Context limit reported"],
    ["attention", "Input may be needed"],
    ["result", "Test result reported"],
  ] as const)("shows the fixed %s hint %s", (kind, label) => {
    const html = renderToStaticMarkup(createElement(SessionPulseBadge, {
      pulse: { ...pulse, bytesSinceViewed: 12_345, hint: { kind, label } }, compact: true,
    }));
    expect(html).toContain(`aria-hidden="true">${label}</span>`);
    expect(html).not.toContain("session-pulse__label");
    expect(html).not.toContain("session-pulse__unread");
  });

  it("shows new output without byte counts in the primary UI", () => {
    const result = sessionPulsePresentation({ ...pulse, bytesSinceViewed: 12_345 });
    expect(result.unread).toBe("New output");
    expect(result.description).toContain("12345 bytes of new output since last viewed");
    const html = renderToStaticMarkup(createElement(SessionPulseBadge, {
      pulse: { ...pulse, bytesSinceViewed: 12_345 }, compact: true,
    }));
    expect(html).toContain('aria-hidden="true">New output</span>');
    expect(html).not.toContain("session-pulse__label");
    expect(sessionPulsePresentation(pulse).unread).toBeNull();
    expect(sessionPulsePresentation({ ...pulse, bytesSinceViewed: Number.NaN }).unread).toBeNull();
    expect(sessionPulsePresentation({ ...pulse, bytesSinceViewed: -1 }).unread).toBeNull();
  });
});
