/**
 * The public landing pages. "/" is the home page; "/start/" is a one-screen
 * page for paid traffic, tested against it. Both get the landing page's
 * analytics, X pixel and Content-Security-Policy, and nothing else does.
 */
export const START_PATH = "/start/";

export function isLandingPath(pathname: string): boolean {
  return pathname === "/" || pathname === "" || pathname === START_PATH;
}
