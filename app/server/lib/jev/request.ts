/**
 * The body of a user-initiated assessment request.
 *
 * The excerpt is what the owner has explicitly disclosed from a pane already
 * open and already decrypted in their own browser; the service never decrypts
 * anything to obtain it and never stores it. The integration bounds and
 * redacts it again before any outbound request, and the observed metadata
 * passes through the integration's typed allowlist, so this parser only has to
 * refuse shapes the route should never accept.
 */
export interface JevAssessRequest {
  excerpt: string;
  generation: number;
  repeatCount?: number;
  observed?: Record<string, unknown>;
}

const ALLOWED = ["excerpt", "generation", "repeatCount", "observed"];

export function readJevAssessRequest(value: unknown): JevAssessRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED.includes(key))) return null;
  const excerpt = record.excerpt;
  if (excerpt !== undefined && typeof excerpt !== "string") return null;
  /* Generous ceiling; the integration clamps and redacts to its own bound. */
  if (typeof excerpt === "string" && excerpt.length > 2_000) return null;
  const generation = record.generation ?? 0;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) return null;
  const repeatCount = record.repeatCount;
  if (
    repeatCount !== undefined &&
    (typeof repeatCount !== "number" || !Number.isFinite(repeatCount) || repeatCount < 0)
  ) {
    return null;
  }
  const observed = record.observed;
  if (observed !== undefined && (!observed || typeof observed !== "object" || Array.isArray(observed))) {
    return null;
  }
  return {
    excerpt: typeof excerpt === "string" ? excerpt : "",
    generation,
    repeatCount: repeatCount as number | undefined,
    observed: observed as Record<string, unknown> | undefined,
  };
}
