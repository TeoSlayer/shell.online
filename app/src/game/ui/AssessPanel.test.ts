import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ASSESSMENT_OFF, type AssessmentFeed } from "../state/assessments";
import { AssessPanel } from "./AssessPanel";

const NOW = 1_000_000;
const noop = () => {};

const feed = (overrides: Partial<AssessmentFeed>): AssessmentFeed => ({
  ...ASSESSMENT_OFF,
  ...overrides,
});

function html(given: Partial<AssessmentFeed>, targets: { sessionId: string; flows: number }[] = []) {
  return renderToStaticMarkup(
    createElement(AssessPanel, { feed: feed(given), targets, busy: false, error: "", now: NOW, onConsent: noop, onAssess: noop }),
  );
}

describe("external analysis panel", () => {
  it("says unavailable instead of pretending when there is no key", () => {
    const markup = html({}, [{ sessionId: "sess001", flows: 2 }]);
    expect(markup).toContain("unavailable");
    expect(markup).toContain("no server-side analysis key is configured");
    expect(markup).toContain("disabled");
  });

  it("says consent is off, and on for a consented feed", () => {
    const off = html({ configured: true }, [{ sessionId: "sess001", flows: 1 }]);
    expect(off).toContain("off");
    expect(off).toContain("external analysis is off for this account");
    const on = html({ configured: true, consent: true, consentUpdatedAt: 1 }, [{ sessionId: "sess001", flows: 1 }]);
    expect(on).not.toContain("external analysis is off");
  });

  it("shows labels with source age and the inferred-not-verified wording", () => {
    const markup = html(
      {
        configured: true,
        consent: true,
        consentUpdatedAt: 1,
        assessments: [
          {
            sessionId: "sess001",
            observedAt: NOW - 12_000,
            expiresAt: NOW + 60_000,
            labels: ["needs_attention", "possible_loop"],
            modelVersion: "jev-1.13.0",
            confidenceFloor: 0.7,
          },
        ],
      },
      [{ sessionId: "sess001", flows: 3 }],
    );
    expect(markup).toContain("needs attention");
    expect(markup).toContain("possible loop");
    expect(markup).toContain("assessed 12s ago");
    expect(markup).toContain("inferred · not verified");
    expect(markup).toContain("Metadata only");
    expect(markup).toContain("never a completion claim");
    expect(markup).not.toContain("completed");
    expect(markup).toContain("cannot send input");
  });
});
