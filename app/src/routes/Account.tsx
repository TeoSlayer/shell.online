import { useState } from "react";
import { SealCheck, SignOut, Warning } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { usePageTitle } from "../lib/page-title";
import { authErrorMessage } from "../lib/auth-errors";
import { useVault } from "../vault/VaultProvider";
import { VaultSetup } from "../vault/VaultGate";

const VAULT_STATE: Record<string, string> = {
  loading: "Checking",
  setup: "Not set up yet. It is set up the first time you open Sessions.",
  locked: "Locked in this browser. Open Sessions to unlock it with your recovery key.",
  error: "Could not be reached",
};

export function Account() {
  usePageTitle("Account");
  const { user, resendVerification, signOutUser } = useAuth();
  const vault = useVault();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

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
        {/*
          The fingerprint is what `shell login` prints when a machine first
          trusts the vault, so the two can be compared by eye.
        */}
        <div className="account-row">
          <dt>Session vault</dt>
          <dd>
            {vault.status === "unlocked" ? (
              <>
                Unlocked, key <span className="vault-fingerprint">{vault.fingerprint}</span>
                {!vault.remembered && (
                  <span className="account-unverified">
                    <Warning size={13} weight="fill" /> this browser cannot keep it unlocked
                  </span>
                )}
              </>
            ) : (
              VAULT_STATE[vault.status]
            )}
          </dd>
        </div>
      </dl>

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
        {(vault.status === "unlocked" || vault.status === "locked") && !resetting && (
          <Button type="button" variant="ghost" onClick={() => setResetting(true)}>
            Reset vault
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
