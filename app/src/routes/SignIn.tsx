import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { usePageTitle } from "../lib/page-title";
import { authErrorMessage } from "../lib/auth-errors";

/**
 * Sign-in is a handoff, not a form.
 *
 * The password belongs to the identity provider and is typed there; this app
 * never sees one. So there is no email field, no password field, and no
 * "forgot password" link — that link lives on the provider's own page, beside
 * the box the password goes in.
 *
 * The screen still exists rather than redirecting on mount. An automatic
 * redirect makes a signed-out session unable to render anything, which is
 * confusing when someone arrives here by signing out, and impossible to get
 * out of when the provider is down.
 */
export function SignIn() {
  usePageTitle("Sign in");
  const { signIn } = useAuth();
  const location = useLocation();
  const destination = (location.state as { from?: string } | null)?.from ?? "/sessions";
  /* Set by the account page after a deletion, so the person is told it worked. */
  const deleted = (location.state as { deleted?: boolean } | null)?.deleted === true;

  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);

  async function go() {
    setFormError("");
    setPending(true);
    try {
      await signIn(destination);
      /*
       * Nothing follows: a successful call has navigated away from this page.
       * Reaching the next line means the redirect did not happen.
       */
    } catch (error) {
      setFormError(authErrorMessage(error));
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back."
      dek={
        <>
          Sign in to manage the sessions you have shared and the links people
          are watching.
        </>
      }
      foot={
        <>
          Your password is set, changed and reset with the identity provider,
          never here. If you have no account yet, ask whoever runs this
          deployment, or register on the provider's page if it offers that.
        </>
      }
      legal={
        <>
          The <Link to="/terms">terms</Link> and the{" "}
          <Link to="/privacy">privacy policy</Link> describe what shell.online
          keeps and why.
        </>
      }
    >
      {deleted && !formError && <Alert tone="success">Your account has been deleted.</Alert>}
      {formError && <Alert tone="error">{formError}</Alert>}

      <Button type="button" onClick={() => void go()} busy={pending} busyLabel="Opening sign-in">
        Continue to sign in
      </Button>
    </AuthShell>
  );
}
