import type { McpFlow } from "./mcp-flows";

/**
 * The optional external-analysis layer, as the game may show it.
 *
 * Everything here is read from the owner's own authenticated endpoint and
 * parsed strictly: a label the service did not allowlist, a row whose model
 * answer is not explicitly `verified: false`, a session the field is not
 * showing, or a row past its TTL is dropped rather than displayed. The layer
 * is advisory: it suggests inspection and never claims completion, never
 * names an action, and never overrides the observed MCP facts.
 */

export const ASSESSMENT_LABELS = ["needs_attention", "possible_loop", "review_requested"] as const;
export type AssessmentLabel = (typeof ASSESSMENT_LABELS)[number];

export interface AssessmentView {
  sessionId: string;
  observedAt: number;
  expiresAt: number;
  labels: AssessmentLabel[];
  modelVersion: string;
  confidenceFloor: number;
}

export interface AssessmentFeed {
  /** Whether the deployment has the server-side secret. False means unavailable. */
  configured: boolean;
  /** The owner's separate consent. Off until explicitly enabled; not implied by anything. */
  consent: boolean;
  consentUpdatedAt: number;
  assessments: AssessmentView[];
}

export const ASSESSMENT_OFF: AssessmentFeed = Object.freeze({
  configured: false,
  consent: false,
  consentUpdatedAt: 0,
  assessments: [],
});

const MAX_ROWS = 32;
const MAX_ROWS_SEEN = MAX_ROWS * 4;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readAssessments(value: unknown, allowed: ReadonlySet<string>, now: number): AssessmentFeed | null {
  const root = record(value);
  if (!root || typeof root.configured !== "boolean") return null;
  const consentRow = record(root.consent);
  if (!consentRow || typeof consentRow.externalAnalysis !== "boolean" || typeof consentRow.updatedAt !== "number") {
    return null;
  }
  if (!Array.isArray(root.assessments)) return null;
  /* Consent off means no rows are rendered, whatever a payload carries. */
  if (consentRow.externalAnalysis !== true) {
    return { configured: root.configured, consent: false, consentUpdatedAt: consentRow.updatedAt, assessments: [] };
  }
  const newest = new Map<string, AssessmentView>();
  for (const raw of root.assessments.slice(0, MAX_ROWS_SEEN)) {
    const row = record(raw);
    if (!row) continue;
    const sessionId = row.sessionId;
    if (typeof sessionId !== "string" || !allowed.has(sessionId)) continue;
    const observedAt = row.observedAt;
    const expiresAt = row.expiresAt;
    if (typeof observedAt !== "number" || typeof expiresAt !== "number" || !(expiresAt > now)) continue;
    const model = record(row.model);
    if (!model || model.kind !== "advisory" || model.verified !== false) continue;
    if (typeof model.modelVersion !== "string" || typeof model.confidenceFloor !== "number") continue;
    if (!Array.isArray(model.labels)) continue;
    const labels = model.labels.filter(
      (label): label is AssessmentLabel =>
        typeof label === "string" && (ASSESSMENT_LABELS as readonly string[]).includes(label),
    );
    /* A label the service did not send is never invented; a row with none
       left after the allowlist is not a finding and is dropped. */
    if (labels.length === 0 || labels.length !== model.labels.length) continue;
    const view: AssessmentView = { sessionId, observedAt, expiresAt, labels, modelVersion: model.modelVersion, confidenceFloor: model.confidenceFloor };
    const existing = newest.get(sessionId);
    if (!existing || existing.observedAt < view.observedAt) newest.set(sessionId, view);
  }
  const assessments = [...newest.values()]
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, MAX_ROWS);
  return {
    configured: root.configured,
    consent: consentRow.externalAnalysis,
    consentUpdatedAt: consentRow.updatedAt,
    assessments,
  };
}

export function assessmentLabelText(label: AssessmentLabel): string {
  const text: Record<AssessmentLabel, string> = {
    needs_attention: "needs attention",
    possible_loop: "possible loop",
    review_requested: "review requested",
  };
  return text[label];
}

/**
 * How old the assessment is. `observedAt` is assigned when the model answers,
 * so this is the assessment's creation age, not an independently preserved
 * source-event time; the label says "assessed" for exactly that reason.
 */
export function sourceAgeLabel(row: AssessmentView, now: number): string {
  const seconds = Math.max(0, Math.round((now - row.observedAt) / 1000));
  return seconds <= 1 ? "assessed just now" : `assessed ${seconds}s ago`;
}

/**
 * A feed belongs to the account it was fetched for. Between an account change
 * and the effect that follows the next render, the previous account's rows
 * must not be handed to the panel; a mismatch and a signed-out render read as
 * off with nothing in them.
 */
export function assessmentsForAccount(feed: AssessmentFeed, stateUid: string, currentUid: string): AssessmentFeed {
  return currentUid !== "" && stateUid === currentUid ? feed : ASSESSMENT_OFF;
}

/**
 * The optimistic view right after the owner moves the consent switch, before
 * the next poll confirms it. Turning consent off clears the rows immediately,
 * so a revoked feed is never rendered while a poll is pending.
 */
export function withLocalConsent(feed: AssessmentFeed, enabled: boolean, updatedAt: number): AssessmentFeed {
  const consentUpdatedAt = Math.max(feed.consentUpdatedAt, updatedAt);
  if (enabled) return { ...feed, consent: true, consentUpdatedAt };
  return { ...feed, consent: false, consentUpdatedAt, assessments: [] };
}

/** The sessions an assessment can target: those the observed feed has shown. */
export function observedTargets(flows: readonly McpFlow[]): { sessionId: string; flows: number }[] {
  const counts = new Map<string, number>();
  for (const flow of flows) {
    if (flow.phase !== "settled") continue;
    counts.set(flow.targetSessionId, (counts.get(flow.targetSessionId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([sessionId, flows]) => ({ sessionId, flows }))
    .sort((left, right) => right.flows - left.flows || (left.sessionId < right.sessionId ? -1 : 1));
}
