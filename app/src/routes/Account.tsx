import { useState } from "react";
import { Link } from "react-router-dom";
import { ChatCircleDots, DownloadSimple, SealCheck, SignOut, Trash, Warning } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { DeleteAccount } from "../components/DeleteAccount";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { fetchDevices, fetchOrg, fetchSessions, fetchVault } from "../lib/api";
import { assigneeIds } from "../lib/session-view";
import { usePageTitle } from "../lib/page-title";
import { authErrorMessage } from "../lib/auth-errors";
import { useVault } from "../vault/VaultProvider";
import { VaultSetup } from "../vault/VaultGate";
import { VaultPanel } from "../vault/VaultPanel";
import { useFeedback } from "../feedback/context";

export function Account() {
  usePageTitle("Account");
  const { mode, user, resendVerification, signOutUser } = useAuth();
  const vault = useVault();
  const feedback = useFeedback();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (!user) return null;
  const accountUser = user;

  const provider = user.providerData?.[0]?.providerId ?? "password";
  const oidcIssuer = import.meta.env.VITE_OIDC_ISSUER ?? "";
  const providerLabel = mode === "oidc"
    ? new URL(oidcIssuer).host
    : provider === "google.com" ? "Google" : "Email and password";

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

  async function handleExport() {
    setError("");
    setExporting(true);
    try {
      const [org, deviceResult, sessionResult, vaultResult] = await Promise.all([
        fetchOrg(), fetchDevices(), fetchSessions(), fetchVault(),
      ]);
      const ownSessions = sessionResult.sessions.filter((session) =>
        session.ownerUid === accountUser.uid || assigneeIds(session).includes(accountUser.uid)
      );
      const data = {
        exportedAt: new Date().toISOString(),
        account: {
          uid: accountUser.uid,
          email: accountUser.email,
          name: accountUser.displayName,
        },
        organization: {
          id: org.organization.id,
          name: org.organization.name,
          role: org.you.role,
          joinedAt: org.you.joinedAt,
        },
        machines: deviceResult.devices,
        sessions: ownSessions,
        vault: vaultResult.vault,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `shell-online-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Your data export has downloaded.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export your data.");
    } finally {
      setExporting(false);
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
        fingerprint in it is what `shell auth` prints when a machine first
        trusts the vault, so the two can be compared by eye.
      */}
      <VaultPanel />

      <section className="account-data-export" aria-labelledby="download-data-title">
        <div>
          <h2 id="download-data-title">Download my data</h2>
          <p>Export your account, team membership, linked machines, sessions assigned to you, and encrypted vault record as JSON.</p>
        </div>
        <Button type="button" variant="ghost" onClick={() => void handleExport()} busy={exporting} busyLabel="Preparing">
          <DownloadSimple size={15} />
          Download JSON
        </Button>
      </section>

      {resetting && (
        <section className="consent-card vault-card vault-reset">
          <VaultSetup
            reset
            onDone={() => {
              setResetting(false);
              setNotice("Your new vault is on. Link your machines again with shell auth.");
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
        {mode === "firebase" && !user.emailVerified && (
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
