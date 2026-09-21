import { describe, expect, it } from "vitest";
import type { McpFlow } from "./mcp-flows";
import { ASSESSMENT_OFF, assessmentsForAccount, observedTargets, readAssessments, sourceAgeLabel, withLocalConsent } from "./assessments";

const NOW = 1_000_000;
const allowed = new Set(["sess001", "sess002"]);

const feed = (assessments: unknown[], overrides: Record<string, unknown> = {}) => ({
  configured: true,
  consent: { externalAnalysis: true, updatedAt: 10 },
  assessments,
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "sess001",
  generation: 1,
  observedAt: NOW - 12_000,
  expiresAt: NOW + 100_000,
  model: { kind: "advisory", labels: ["needs_attention"], modelVersion: "jev-1.13.0", verified: false, confidenceFloor: 0.7 },
  observed: {},
  disclaimer: "",
  ...overrides,
});

const flow = (overrides: Partial<McpFlow>): McpFlow => ({
  id: "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f",
  targetSessionId: "sess001",
  tool: "shell_send",
  phase: "settled",
  at: NOW,
  outcome: "delivered",
  ...overrides,
});

describe("assessment feed parser", () => {
  it("keeps only live observed sessions and drops expired rows", () => {
    const parsed = readAssessments(
      feed([row(), row({ sessionId: "gone", observedAt: NOW }), row({ sessionId: "sess002", expiresAt: NOW - 1 })]),
      allowed,
      NOW,
    );
    expect(parsed?.assessments.map((entry) => entry.sessionId)).toEqual(["sess001"]);
  });

  it("never invents a label and refuses a row that is not explicitly unverified", () => {
    const parsed = readAssessments(
      feed([
        row({ model: { kind: "advisory", labels: ["definitely_done"], modelVersion: "v", verified: false, confidenceFloor: 0.7 } }),
        row({ sessionId: "sess002", model: { kind: "advisory", labels: ["needs_attention"], modelVersion: "v", verified: true, confidenceFloor: 0.7 } }),
        row({ model: { kind: "unknown", reason: "no_signal" } }),
      ]),
      allowed,
      NOW,
    );
    expect(parsed?.assessments).toEqual([]);
  });

  it("keeps the newest row per session and returns null on structural junk", () => {
    const parsed = readAssessments(
      feed([
        row({ observedAt: NOW - 30_000 }),
        row({ observedAt: NOW - 1_000, model: { kind: "advisory", labels: ["possible_loop"], modelVersion: "v", verified: false, confidenceFloor: 0.7 } }),
      ]),
      allowed,
      NOW,
    );
    expect(parsed?.assessments).toHaveLength(1);
    expect(parsed?.assessments[0].labels).toEqual(["possible_loop"]);

    expect(readAssessments({ configured: true, assessments: [] }, allowed, NOW)).toBeNull();
    expect(readAssessments({ configured: "yes", consent: { externalAnalysis: false, updatedAt: 0 }, assessments: [] }, allowed, NOW)).toBeNull();
    expect(ASSESSMENT_OFF.configured).toBe(false);
  });

  it("labels the assessment age plainly, never a source-event time", () => {
    expect(sourceAgeLabel({ sessionId: "s", observedAt: NOW - 12_000, expiresAt: 0, labels: [], modelVersion: "", confidenceFloor: 0 }, NOW)).toBe("assessed 12s ago");
    expect(sourceAgeLabel({ sessionId: "s", observedAt: NOW, expiresAt: 0, labels: [], modelVersion: "", confidenceFloor: 0 }, NOW)).toBe("assessed just now");
  });

  it("drops every row when the payload says consent is off", () => {
    const parsed = readAssessments(
      { configured: true, consent: { externalAnalysis: false, updatedAt: 9 }, assessments: [row()] },
      allowed,
      NOW,
    );
    expect(parsed?.consent).toBe(false);
    expect(parsed?.assessments).toEqual([]);
  });

  it("shows a feed only to the account it was fetched for", () => {
    const feedValue = { configured: true, consent: true, consentUpdatedAt: 1, assessments: [] };
    expect(assessmentsForAccount(feedValue, "uid-1", "uid-1")).toBe(feedValue);
    expect(assessmentsForAccount(feedValue, "uid-1", "uid-2")).toBe(ASSESSMENT_OFF);
    expect(assessmentsForAccount(feedValue, "uid-1", "")).toBe(ASSESSMENT_OFF);
  });

  it("clears rows the moment consent is locally withdrawn", () => {
    const feedValue = {
      configured: true,
      consent: true,
      consentUpdatedAt: 1,
      assessments: [{ sessionId: "sess001", observedAt: NOW, expiresAt: NOW + 1000, labels: ["needs_attention" as const], modelVersion: "v", confidenceFloor: 0.7 }],
    };
    const off = withLocalConsent(feedValue, false, 2);
    expect(off.consent).toBe(false);
    expect(off.assessments).toEqual([]);
    expect(off.consentUpdatedAt).toBe(2);
    const on = withLocalConsent(ASSESSMENT_OFF, true, 3);
    expect(on.consent).toBe(true);
    expect(on.consentUpdatedAt).toBe(3);
  });

  it("targets only sessions with a settled observed request, most active first", () => {
    const targets = observedTargets([
      flow({ id: "a", targetSessionId: "sess002" }),
      flow({ id: "b", targetSessionId: "sess002" }),
      flow({ id: "c", targetSessionId: "sess001" }),
      flow({ id: "d", targetSessionId: "sess001", phase: "started", outcome: undefined }),
    ]);
    expect(targets).toEqual([
      { sessionId: "sess002", flows: 2 },
      { sessionId: "sess001", flows: 1 },
    ]);
  });
});
