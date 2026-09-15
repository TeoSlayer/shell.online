/*
 * Sign-in happens at the identity provider, so the errors this app can show
 * are the ones raised getting there and back: a provider that is unreachable,
 * a callback that did not complete, a session that has gone. The provider
 * shows its own messages for a wrong password, an unknown account, or a
 * registration it refused, on its own page.
 */

export function authErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong on our side. Try again.";
}

/* Returns 0-4. Length carries most of the weight; variety breaks ties. */
export function passwordScore(value: string): number {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value) || /[^\w\s]/.test(value)) score += 1;
  return Math.min(score, 4);
}

export const PASSWORD_LABELS = ["", "weak", "fair", "good", "strong"] as const;
