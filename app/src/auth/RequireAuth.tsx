import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { AppShell } from "../components/AppShell";
import { Booting } from "../components/Booting";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    /*
     * Inside the shell, not instead of it. On a phone the shell is what
     * carries the navigation bar along the bottom, so a bare card here meant
     * the bar was absent for as long as the session check took and then
     * appeared under the page once it finished. The wait is the same wait; it
     * now happens in the frame the page is about to fill.
     */
    return (
      <AppShell title="Loading">
        <Booting label="Checking your session" />
      </AppShell>
    );
  }
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }
  return <>{children}</>;
}

export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();

  if (initializing) {
    return <Booting label="Checking your session" />;
  }
  if (user) {
    return <Navigate to="/sessions" replace />;
  }
  return <>{children}</>;
}
