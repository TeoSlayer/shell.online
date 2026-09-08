/**
 * The flag `shell login` sends the browser back with.
 *
 * The CLI's loopback callback redirects to `/sessions?linked=1` once it has
 * its authorization code, so the confirmation lands on the page the terminal's
 * sessions appear on rather than on a page served by the CLI itself.
 *
 * The other end of this contract is `signedInPath` in
 * internal/account/login.go. Renaming one without the other means a person
 * signs in and nothing tells them so.
 */
export const LINKED_PARAM = "linked";

/** True when this navigation is the one that just linked a terminal. */
export function wasJustLinked(search: string | URLSearchParams): boolean {
  const parameters = typeof search === "string" ? new URLSearchParams(search) : search;
  return parameters.get(LINKED_PARAM) === "1";
}

/**
 * The same query with the flag removed.
 *
 * It is dropped as soon as it is read, so a reload, a bookmark or a shared
 * link does not announce a sign-in that did not just happen.
 */
export function withoutLinkedFlag(search: string | URLSearchParams): URLSearchParams {
  const parameters = new URLSearchParams(
    typeof search === "string" ? search : search.toString(),
  );
  parameters.delete(LINKED_PARAM);
  return parameters;
}
