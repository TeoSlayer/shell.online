import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { UsersThree } from "@phosphor-icons/react";
import { Wordmark } from "../components/Wordmark";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { Booting } from "../components/Booting";
import { useAuth } from "../auth/AuthProvider";
import { fetchOrg, accountsBaseUrl } from "../lib/api";

interface Preview {
  organization: { name: string };
  role: string;
  email: string | null;
  usable: boolean;
}

/**
 * The screen an invite link lands on.
 *
 * It describes the organization before anyone signs in, so the recipient knows
 * what they are joining rather than being asked to authenticate first and find
 * out afterwards.
 */
export function Join() {
  const { inviteId = "" } = useParams();
  const { user, initializing } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${accountsBaseUrl}/api/invites/${encodeURIComponent(inviteId)}`)
      .then(async (response) => {
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) setError(body.error ?? "That invite link is not valid.");
        else setPreview(body as Preview);
      })
      .catch(() => {
        if (!cancelled) setError("Could not reach the accounts service.");
      });
    return () => {
      cancelled = true;
    };
  }, [inviteId]);

  if (initializing) return <Booting label="Checking your session" />;

  /* Signing in has to come back here, or the invite is lost on the way. */
  if (!user) {
    return (
      <Navigate
        to="/signup"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  async function handleJoin() {
    setJoining(true);
    setError("");
    try {
      const result = await fetchOrg(inviteId);
      if (result.inviteError) {
        setError(result.inviteError);
        setJoining(false);
        return;
      }
      navigate("/sessions", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join.");
      setJoining(false);
    }
  }

  return (
    <main className="consent">
      <header className="consent-head">
        <Wordmark />
        <span className="consent-account">{user.email}</span>
      </header>

      <section className="consent-card rise rise-1">
        <span className="consent-mark" aria-hidden="true">
          <UsersThree size={22} />
        </span>

        {error && !preview ? (
          <>
            <h1>This invite is not usable.</h1>
            <p>{error}</p>
          </>
        ) : !preview ? (
          <>
            <h1>Checking the invite.</h1>
            <p>One moment.</p>
          </>
        ) : (
          <>
            <h1>Join {preview.organization.name}?</h1>
            <p>
              You are signed in as <b>{user.email}</b>. Joining lets you see the
              sessions everyone in {preview.organization.name} is running, and
              lets them see yours.
            </p>

            {error && (
              <div className="consent-alert">
                <Alert tone="error">{error}</Alert>
              </div>
            )}

            <dl className="consent-rows">
              <div className="consent-row">
                <dt>Organization</dt>
                <dd>{preview.organization.name}</dd>
              </div>
              <div className="consent-row">
                <dt>You join as</dt>
                <dd>{preview.role === "admin" ? "Admin" : "Member"}</dd>
              </div>
              {preview.email && (
                <div className="consent-row">
                  <dt>Issued for</dt>
                  <dd>{preview.email}</dd>
                </div>
              )}
            </dl>

            <div className="consent-actions">
              <Button
                type="button"
                onClick={handleJoin}
                busy={joining}
                busyLabel="Joining"
                disabled={!preview.usable}
              >
                Join {preview.organization.name}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate("/sessions")}>
                Not now
              </Button>
            </div>

            {!preview.usable && (
              <p className="consent-note">
                <span>This invite has already been used, revoked or expired.</span>
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
