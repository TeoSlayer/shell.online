import { useState } from "react";
import { SealCheck, SignOut, Warning } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { usePageTitle } from "../lib/page-title";
import { authErrorMessage } from "../lib/auth-errors";

export function Account() {
  usePageTitle("Account");
  const { user, resendVerification, signOutUser } = useAuth();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const provider = user.providerData[0]?.providerId ?? "password";
  const providerLabel = provider === "google.com" ? "Google" : "Email and password";

  async function handleResend() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await resendVerification();
      setNotice("Verification email sent. Check your inbox.");
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell title="Account">
      <p className="page-dek">Who you are signed in as.</p>

      {notice && <div className="sessions-alert"><Alert tone="success">{notice}</Alert></div>}
      {error && <div className="sessions-alert"><Alert tone="error">{error}</Alert></div>}

      <dl className="account-rows">
        <div className="account-row">
          <dt>Name</dt>
          <dd>{user.displayName || "Not set"}</dd>
        </div>
        <div className="account-row">
          <dt>Email</dt>
          <dd>
            {user.email}
            {user.emailVerified ? (
              <span className="account-verified">
                <SealCheck size={13} weight="fill" /> verified
              </span>
            ) : (
              <span className="account-unverified">
                <Warning size={13} weight="fill" /> not verified
              </span>
            )}
          </dd>
        </div>
        <div className="account-row">
          <dt>Signed in with</dt>
          <dd>{providerLabel}</dd>
        </div>
        <div className="account-row">
          <dt>User id</dt>
          <dd>{user.uid}</dd>
        </div>
      </dl>

      {/*
        Sign out lives here as well as in the sidebar. On a phone the sidebar
        becomes a bar of destinations with no room for the account row, and
        this is the destination that row would have led to, so leaving it out
        would strand anybody who opened the app from a home screen.
      */}
      <div className="account-actions">
        {!user.emailVerified && (
          <Button
            type="button"
            variant="ghost"
            onClick={handleResend}
            busy={busy}
            busyLabel="Sending"
          >
            Resend verification
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={() => void signOutUser()}>
          <SignOut size={15} />
          Sign out
        </Button>
      </div>
    </AppShell>
  );
}
