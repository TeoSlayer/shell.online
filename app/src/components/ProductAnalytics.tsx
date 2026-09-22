import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { observeProductPage, resetProductIdentity, trackProduct } from "../../../web/posthog";

export function ProductAnalytics() {
  const { pathname } = useLocation();
  const { user, initializing } = useAuth();
  // Account identity stays in this ref, never in analytics properties or persistence.
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (initializing) return;
    const next = user?.uid ?? null;
    if (previous.current !== undefined && previous.current !== next) {
      if (previous.current !== null) trackProduct("signed_out");
      resetProductIdentity();
      if (next !== null) trackProduct("signed_in");
    }
    previous.current = next;
  }, [user?.uid, initializing]);
  useEffect(() => {
    // Defer to avoid React StrictMode's setup/cleanup probe counting a visit twice.
    let end: (() => void) | undefined;
    const timer = setTimeout(() => { end = observeProductPage(); }, 0);
    return () => { clearTimeout(timer); end?.(); };
  }, [pathname]);
  return null;
}
