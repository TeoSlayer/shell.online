/**
 * Bounds shared by the Jev integration and the stores.
 *
 * One source of truth, so the distributed budget the stores enforce cannot
 * drift from what the integration promises, and the assessment lifetime the
 * UI reads cannot drift from what the store keeps.
 */
export const JEV_ASSESSMENT_TTL_MS = 120_000;
export const JEV_MAX_SNAPSHOTS = 32;
export const JEV_MAX_EXCERPT_CHARS = 600;

/**
 * The distributed sliding window: assessments per owner and the total
 * characters of outbound state within the window. The provider keeps a
 * process-local copy of the same shape; this one is the shared authority.
 */
export const JEV_BUDGET = Object.freeze({
  windowMs: 60_000,
  maxRequests: 6,
  maxInputChars: 8_000,
});
