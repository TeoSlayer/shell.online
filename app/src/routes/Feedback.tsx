import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { AuthShell } from "../components/AuthShell";
import { useAuth } from "../auth/AuthProvider";
import { Button } from "../components/Button";
import { useFeedback } from "../feedback/context";
import { usePageTitle } from "../lib/page-title";

/** A linkable entry to the same report form, with or without an account. */
export function Feedback() {
  usePageTitle("Send feedback");
  const { open } = useFeedback();
  const { user } = useAuth();
  const [search] = useSearchParams();
  // Only a fixed source label crosses from the viewer, never its URL or content.
  const fromTerminal = search.get("from") === "terminal";
  const openForm = useCallback(() => open({
    surface: fromTerminal ? "shared-terminal" : "feedback-page",
    kind: "problem",
  }), [open, fromTerminal]);

  useEffect(openForm, [openForm]);

  if (!user) return (
    <AuthShell title="Tell us what went wrong" dek="No account needed. Your terminal stays open in its own tab."
      headLink={{ to: "/login", label: "Sign in" }}>
      <p>No terminal text, passwords or sharing links are attached.</p>
      <Button onClick={openForm}>Open feedback form</Button>
    </AuthShell>
  );

  return (
    <AppShell title="Send feedback">
      <p className="page-dek">
        Tell us what happened and what you expected. Your terminal stays open in its own tab.
        No terminal text, passwords, or sharing links are attached.
      </p>
      <Button onClick={openForm}>Open feedback form</Button>
    </AppShell>
  );
}
