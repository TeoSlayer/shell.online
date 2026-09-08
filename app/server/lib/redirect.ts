/**
 * The CLI callback must be a loopback listener on this machine. Anything else
 * would let a crafted authorize link forward a live code to a remote host, so
 * the check is an allowlist rather than a blocklist.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export function isValidRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  if (!url.port) return false;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  if (url.pathname !== "/callback") return false;
  if (url.search || url.hash) return false;
  if (url.username || url.password) return false;
  return true;
}

/** Appends the code and state without disturbing an existing path. */
export function buildRedirect(redirectUri: string, code: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}
