import { useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Terminal, ShieldCheck } from "@phosphor-icons/react";
import { Wordmark } from "../components/Wordmark";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { Booting } from "../components/Booting";
import { approveCliLogin } from "../lib/api";
import { buildCallback, parseAuthorizeRequest } from "../lib/cli-authorize";

export function CliAuthorize() {
  const { user, initializing } = useAuth();
  const location = useLocation();
  const parsed = useMemo(() => parseAuthorizeRequest(location.search), [location.search]);

  const [busy, setBusy] = useState<"none" | "approve" | "deny">("none");
  const [error, setError] = useState("");
  const [handedOff, setHandedOff] = useState(false);

  if (initializing) return <Booting label="Checking your session" />;

  /*
   * Signing up, not signing in: somebody running `shell login` for the first
   * time has no account yet, and the sign-in form is a dead end for them. The
   * page links to sign-in for everyone else, carrying this state across.
   *
   * Either way the return path has to be this exact URL, query string
   * included, or the request the CLI is waiting on is lost.
   */
  if (!user) {
    return (
      <Navigate
        to="/signup"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  async function handleApprove() {
    if (!parsed.ok) return;
    setError("");
    setBusy("approve");
    try {
      const { code } = await approveCliLogin({
        redirectUri: parsed.request.redirectUri,
        codeChallenge: parsed.request.codeChallenge,
      });
      setHandedOff(true);
      window.location.replace(
        buildCallback(parsed.request.redirectUri, { code, state: parsed.request.state }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not complete the request.");
      setBusy("none");
    }
  }

  function handleDeny() {
    if (!parsed.ok) return;
    setBusy("deny");
    setHandedOff(true);
    window.location.replace(
      buildCallback(parsed.request.redirectUri, {
        error: "access_denied",
        error_description: "You declined the request.",
        state: parsed.request.state,
      }),
    );
  }

  return (
    <main className="consent">
      <header className="consent-head">
        <Wordmark />
        <span className="consent-account">{user.email}</span>
      </header>

      <section className="consent-card rise rise-1">
        <span className="consent-mark" aria-hidden="true">
          <Terminal size={22} weight="regular" />
        </span>

        {!parsed.ok ? (
          <>
            <h1>This link is not usable.</h1>
            <p>{parsed.reason}</p>
            <p className="consent-hint">
              Run <code>shell login</code> in your terminal to start again.
            </p>
          </>
        ) : (
          <>
            <h1>Link this terminal?</h1>
            <p>
              A terminal on this computer is asking to sign in as{" "}
              <b>{user.email}</b>. Once linked, sessions you start with{" "}
              <code>shell</code> show up in your account.
            </p>

            {error && (
              <div className="consent-alert">
                <Alert tone="error">{error}</Alert>
              </div>
            )}

            <dl className="consent-rows">
              <div className="consent-row">
                <dt>Requested by</dt>
                <dd>
                  A local process on 127.0.0.1, port {parsed.request.port}
                </dd>
              </div>
              <div className="consent-row">
                <dt>Grants</dt>
                <dd>Publishing your sessions to this account</dd>
              </div>
              <div className="consent-row">
                <dt>Does not grant</dt>
                <dd>Reading terminal output, or your password</dd>
              </div>
            </dl>

            <div className="consent-actions">
              <Button
                type="button"
                onClick={handleApprove}
                busy={busy === "approve" || handedOff}
                busyLabel="Linking"
                disabled={busy !== "none"}
              >
                Link terminal
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleDeny}
                disabled={busy !== "none"}
              >
                Cancel
              </Button>
            </div>

            <p className="consent-note">
              <ShieldCheck size={14} weight="bold" />
              <span>
                Terminal content stays end-to-end encrypted. Only the link, the
                command name and the timing are published.
              </span>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
