import { useState } from "react";
import { Link } from "react-router-dom";
import { ChatCircleDots, SealCheck, SignOut, Trash, Warning } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { DeleteAccount } from "../components/DeleteAccount";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { usePageTitle } from "../lib/page-title";
import { authErrorMessage } from "../lib/auth-errors";
import { useVault } from "../vault/VaultProvider";
import { VaultSetup } from "../vault/VaultGate";
import { VaultPanel } from "../vault/VaultPanel";
import { useFeedback } from "../feedback/context";

export function Account() {
  usePageTitle("Account");
  const { user, signOutUser } = useAuth();
  const vault = useVault();
  const feedback = useFeedback();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!user) return null;

  /*
   * The host of the issuer, which is as much as this app knows about where
   * the account lives. It holds no password and cannot change one.
   */
  const issuer = import.meta.env.VITE_OIDC_ISSUER ?? "";
  const providerLabel = issuer ? new URL(issuer).host : "an identity provider";

  async function handleSignOut() {
    setError("");
    setSigningOut(true);
    try {
      await signOutUser();
    } catch (caught) {
      setError(authErrorMessage(caught));
      setSigningOut(false);
    }
  }

  return (
    <AppShell title="Account">
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
        {/* The vault has its own section below, which says what it holds. */}
        <div className="account-row">
          <dt>Your data</dt>
          <dd>
            What shell.online keeps, and for how long, is in the{" "}
            <Link to="/privacy">privacy policy</Link>.
          </dd>
        </div>
      </dl>

      {/*
        What the vault is and what it holds, opened in this browser. The key
        fingerprint in it is what `shell login` prints when a machine first
        trusts the vault, so the two can be compared by eye.
      */}
      <VaultPanel />

      {resetting && (
        <section className="consent-card vault-card vault-reset">
          <VaultSetup
            reset
            onDone={() => {
              setResetting(false);
              setNotice("Your new vault is on. Link your machines again with shell login.");
            }}
          />
          <Button type="button" variant="ghost" onClick={() => setResetting(false)}>
            Keep my current vault
          </Button>
        </section>
      )}

      {/*
        Sign out lives here as well as in the sidebar. On a phone the sidebar
        becomes a bar of destinations with no room for the account row, and
        this is the destination that row would have led to, so leaving it out
        would strand anybody who opened the app from a home screen.
      */}
      <p className="account-note">
        Your name, email address and password belong to {providerLabel}. Change
        them, or verify your address, there — this app only reads them.
      </p>

      <div className="account-actions">
        {(vault.status === "unlocked" || vault.status === "locked") && !resetting && (
          <Button type="button" variant="ghost" onClick={() => setResetting(true)}>
            Reset vault
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={() => feedback.open({ surface: "account" })}>
          <ChatCircleDots size={15} />
          Send feedback
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void handleSignOut()}
          busy={signingOut}
          busyLabel="Signing out"
        >
          <SignOut size={15} />
          Sign out
        </Button>
      </div>

      {deleting ? (
        <DeleteAccount onCancel={() => setDeleting(false)} />
      ) : (
        <section className="account-danger-zone" aria-labelledby="delete-account-title">
          <div>
            <h2 id="delete-account-title">Delete account</h2>
            <p>
              Permanently remove your account, linked machines, sessions and vault data.
            </p>
          </div>
          <Button type="button" variant="danger" onClick={() => setDeleting(true)}>
            <Trash size={15} />
            Delete account
          </Button>
        </section>
      )}
    </AppShell>
  );
}
