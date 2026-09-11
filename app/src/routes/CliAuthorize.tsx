import { useMemo, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Terminal, ShieldCheck } from "@phosphor-icons/react";
import { Wordmark } from "../components/Wordmark";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { Booting } from "../components/Booting";
import { approveCliLogin } from "../lib/api";
import { usePageTitle } from "../lib/page-title";
import { buildCallback, parseAuthorizeRequest, type AuthorizeRequest } from "../lib/cli-authorize";
import { VaultGate } from "../vault/VaultGate";
import { useVault } from "../vault/VaultProvider";

export function CliAuthorize() {
  usePageTitle("Link a machine");
  const { user, initializing } = useAuth();
  const location = useLocation();
  const parsed = useMemo(() => parseAuthorizeRequest(location.search), [location.search]);

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

  /*
   * Behind the vault, like the sessions page. The machine being linked will
   * seal every session's password to the vault key, and it takes that key
   * from this page, so the page must hold one it has verified itself.
   */
  return (
    <VaultGate>
      <Consent email={user.email ?? ""} parsed={parsed} />
    </VaultGate>
  );
}

function Consent({
  email,
  parsed,
}: {
  email: string;
  parsed: { ok: true; request: AuthorizeRequest } | { ok: false; reason: string };
}) {
  const vault = useVault();
  const [busy, setBusy] = useState<"none" | "approve" | "deny">("none");
  const [error, setError] = useState("");
  const [handedOff, setHandedOff] = useState(false);

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
      /*
       * The vault key goes to the CLI with the code, straight to its loopback
       * listener. It is the key this browser checked against the vault's
       * private half when it unlocked, so a service that wanted a machine to
       * seal to some other key would have to get it past this page, not just
       * put it in an API response.
       */
      const params: Record<string, string> = { code, state: parsed.request.state };
      if (vault.publicKey) params.account_key = vault.publicKey;
      window.location.replace(buildCallback(parsed.request.redirectUri, params));
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
        <span className="consent-account">{email}</span>
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
              <b>{email}</b>. Once linked, sessions you start with{" "}
              <code>shell</code> show up in your account, and everyone on your
              team can see them.
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
                <dd>
                  Publishing this machine&rsquo;s sessions to your team, with
                  their passwords sealed to your vault
                </dd>
              </div>
              {/*
                What publishing means, spelled out. Terms sections "What Is Sent
                to the Service" and "Activity Records" are the long form; these
                two rows must not promise less than they do.
              */}
              <div className="consent-row">
                <dt>Your team sees</dt>
                <dd>
                  Each session&rsquo;s link, full command line, machine name,
                  session name and timings
                </dd>
              </div>
              <div className="consent-row">
                <dt>Recorded</dt>
                <dd>What anyone types into a session from a browser</dd>
              </div>
              <div className="consent-row">
                <dt>Does not grant</dt>
                <dd>Reading terminal output, or opening your vault</dd>
              </div>
              {vault.fingerprint && (
                <div className="consent-row">
                  <dt>Vault key</dt>
                  <dd className="vault-fingerprint">{vault.fingerprint}</dd>
                </div>
              )}
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
                Terminal output stays end-to-end encrypted, and passwords reach
                this account sealed, so shell.online cannot open them. The link,
                command line, machine name and timings are shared with your
                team, and what you type from a browser is recorded. Starting
                sessions from a browser is a separate choice, made in your
                terminal. The{" "}
                <Link to="/terms" target="_blank" rel="noreferrer">
                  terms
                </Link>{" "}
                list everything that is kept.
              </span>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
