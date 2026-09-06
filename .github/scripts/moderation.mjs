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

function requireString(value, key) {
  if (typeof value[key] !== "string" || value[key].trim() === "") {
    throw new TypeError(`model output requires a non-empty ${key} string`);
  }
}

function requireConfidence(value) {
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    throw new TypeError("model output confidence must be between 0 and 1");
  }
}

function requireEnum(value, key, allowed) {
  if (!allowed.includes(value[key])) throw new TypeError(`model output has invalid ${key}`);
}

function requireStringArray(value, key) {
  if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== "string")) {
    throw new TypeError(`model output ${key} must be a string array`);
  }
}

export function validateIssueAssessment(value) {
  requireEnum(value, "classification", ["actionable", "needs_information", "unrelated", "spam"]);
  requireConfidence(value);
  if (typeof value.technical_substance !== "boolean") throw new TypeError("model output requires technical_substance");
  requireString(value, "summary");
  requireString(value, "reason");
  requireStringArray(value, "missing_information");
  return value;
}

export function validateIssueVerifier(value) {
  requireEnum(value, "decision", ["keep", "delete"]);
  requireConfidence(value);
  requireString(value, "reason");
  return value;
}

export function validatePullRequestAssessment(value) {
  requireEnum(value, "classification", ["relevant", "needs_changes", "unrelated", "spam"]);
  requireConfidence(value);
  if (typeof value.technical_substance !== "boolean") throw new TypeError("model output requires technical_substance");
  if (typeof value.changelog_required !== "boolean" || typeof value.changelog_present !== "boolean") {
    throw new TypeError("model output requires changelog booleans");
  }
  requireString(value, "summary");
  requireString(value, "reason");
  if (typeof value.changelog_entry !== "string") throw new TypeError("model output requires changelog_entry");
  if (!Array.isArray(value.findings)) throw new TypeError("model output findings must be an array");
  for (const finding of value.findings) {
    requireEnum(finding, "severity", ["blocking", "important", "suggestion"]);
    if (typeof finding.path !== "string") throw new TypeError("finding path must be a string");
    requireString(finding, "message");
  }
  return value;
}

export function validatePullRequestVerifier(value) {
  requireEnum(value, "decision", ["keep_open", "close"]);
  requireConfidence(value);
  requireString(value, "reason");
  return value;
}

export function validateReleaseNotes(value) {
  requireString(value, "headline");
  requireString(value, "summary");
  for (const key of ["highlights", "fixes", "compatibility", "verification"]) requireStringArray(value, key);
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
