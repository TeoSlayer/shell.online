const PROTECTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REMOVABLE_ISSUE_CLASSES = new Set(["unrelated", "spam"]);
const CLOSABLE_PR_CLASSES = new Set(["unrelated", "spam"]);

export const AUTO_MODERATION_CONFIDENCE = 0.98;

export function parseModelJson(raw) {
  if (typeof raw !== "string") throw new TypeError("model output must be a string");
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(cleaned);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("model output must be a JSON object");
  }
  return value;
}

export function shouldDeleteIssue(primary, verifier, authorAssociation = "NONE") {
  if (PROTECTED_ASSOCIATIONS.has(authorAssociation)) return false;
  return (
    REMOVABLE_ISSUE_CLASSES.has(primary.classification) &&
    primary.technical_substance === false &&
    Number(primary.confidence) >= AUTO_MODERATION_CONFIDENCE &&
    verifier.decision === "delete" &&
    Number(verifier.confidence) >= AUTO_MODERATION_CONFIDENCE
  );
}

export function shouldClosePullRequest(primary, verifier, authorAssociation = "NONE") {
  if (PROTECTED_ASSOCIATIONS.has(authorAssociation)) return false;
  return (
    CLOSABLE_PR_CLASSES.has(primary.classification) &&
    primary.technical_substance === false &&
    Number(primary.confidence) >= AUTO_MODERATION_CONFIDENCE &&
    verifier.decision === "close" &&
    Number(verifier.confidence) >= AUTO_MODERATION_CONFIDENCE
  );
}

export function issueLabel(primary) {
  switch (primary.classification) {
    case "actionable": return "ai: actionable";
    case "needs_information": return "needs-info";
    case "unrelated": return "moderation: unrelated";
    case "spam": return "moderation: spam";
    default: return "ai: review-needed";
  }
}

export function pullRequestLabel(primary) {
  switch (primary.classification) {
    case "relevant": return "ai: reviewed";
    case "needs_changes": return "needs-changes";
    case "unrelated": return "moderation: unrelated";
    case "spam": return "moderation: spam";
    default: return "ai: review-needed";
  }
}
