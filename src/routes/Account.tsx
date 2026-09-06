import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wordmark } from "../components/Wordmark";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { authErrorMessage } from "../lib/auth-errors";

/*
 * Placeholder landing surface behind the guard. It exists to prove the whole
 * loop works end to end; the session list lands here next.
 */
export function Account() {
  const { user, signOutUser, resendVerification } = useAuth();
  const navigate = useNavigate();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"none" | "verify" | "out">("none");

  if (!user) return null;

  const provider = user.providerData[0]?.providerId ?? "password";
  const providerLabel =
    provider === "google.com" ? "Google" : "Email and password";

  async function handleResend() {
    setError("");
    setNotice("");
    setBusy("verify");
    try {
      await resendVerification();
      setNotice("Verification email sent. Check your inbox.");
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy("none");
    }
  }

  async function handleSignOut() {
    setBusy("out");
    try {
      await signOutUser();
      navigate("/login", { replace: true });
    } catch (caught) {
      setError(authErrorMessage(caught));
      setBusy("none");
    }
  }

  return (
    <main className="account">
      <header className="account-head">
        <Wordmark />
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {user.email}
        </span>
      </header>

      <section className="account-card">
        <h1>You are signed in.</h1>
        <p>
          Account plumbing is live. Session management, shared links, and team
          access build on top of this.
        </p>

        {notice && <div style={{ marginTop: 22 }}><Alert tone="success">{notice}</Alert></div>}
        {error && <div style={{ marginTop: 22 }}><Alert tone="error">{error}</Alert></div>}

        <dl className="account-rows">
          <div className="account-row">
            <dt>Name</dt>
            <dd>{user.displayName || "Not set"}</dd>
          </div>
          <div className="account-row">
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div className="account-row">
            <dt>Signed in with</dt>
            <dd>{providerLabel}</dd>
          </div>
          <div className="account-row">
            <dt>Email verified</dt>
            <dd>{user.emailVerified ? "Yes" : "Not yet"}</dd>
          </div>
          <div className="account-row">
            <dt>User id</dt>
            <dd>{user.uid}</dd>
          </div>
        </dl>

        <div className="account-actions">
          {!user.emailVerified && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleResend}
              busy={busy === "verify"}
              busyLabel="Sending"
              disabled={busy !== "none"}
            >
              Resend verification
            </Button>
          )}
          <Button
            type="button"
            onClick={handleSignOut}
            busy={busy === "out"}
            busyLabel="Signing out"
            disabled={busy !== "none"}
          >
            Sign out
          </Button>
        </div>
      </section>
    </main>
  );
}
