/** Where an owner manages a session's password requests: its page, at that section. */
export const PASSWORD_REQUESTS_ANCHOR = "password-requests";

export function passwordRequestsHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}#${PASSWORD_REQUESTS_ANCHOR}`;
}
