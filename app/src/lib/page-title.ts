import { useEffect } from "react";

const SUFFIX = "shell.online";

/**
 * Sets the document title while a route is on screen.
 *
 * index.html carries one title for the whole application, which is what the
 * document is called before React runs and what a crawler sees. Every page
 * then inherited it, so the machines list, the audit log and the terms all
 * announced themselves as "Sign in" -- in the tab strip, in a bookmark, and
 * in the name a phone gives the icon when the app is saved to a home screen.
 *
 * Restoring the previous title on the way out matters for the same reason it
 * matters here: a route that unmounts without doing so leaves its name on
 * whatever comes next.
 */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} | ${SUFFIX}` : SUFFIX;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
