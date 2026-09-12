import { useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, DownloadSimple, Fingerprint, Key, LockKey, ShieldCheck, Warning } from "@phosphor-icons/react";
import { Wordmark } from "../components/Wordmark";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { Booting } from "../components/Booting";
import { useAuth } from "../auth/AuthProvider";
import { COPY_FAILED, useCopy } from "../lib/clipboard";
import { useVault, type PreparedVault } from "./VaultProvider";

/**
 * Compatibility gate for routes that explicitly require an open vault.
 * Sessions themselves do not use it: the vault is optional and a password can
 * always be entered directly when opening a terminal.
 */
export function VaultGate({ children }: { children: ReactNode }) {
  const vault = useVault();
  if (vault.status === "unlocked") return <>{children}</>;
  if (vault.status === "loading") return <Booting label="Opening your vault" />;
  if (vault.status === "error") {
    return (
      <VaultFrame>
        <span className="consent-mark" aria-hidden="true">
          <Warning size={22} />
        </span>
        <h1>Your vault could not be reached</h1>
        <p>{vault.error}</p>
        <div className="consent-actions">
          <Button type="button" onClick={vault.retry}>
            Try again
          </Button>
        </div>
      </VaultFrame>
    );
  }
  if (vault.status === "setup") {
    return (
      <VaultFrame>
        <VaultSetup reset={false} />
      </VaultFrame>
    );
  }
  return (
    <VaultFrame>
      <VaultUnlock />
    </VaultFrame>
  );
}

function VaultFrame({ children }: { children: ReactNode }) {
  const { user, signOutUser } = useAuth();
  return (
    <main className="consent">
      <header className="consent-head">
        <Wordmark />
        <span className="consent-account">
          {user?.email}
          {/* The gate is on the way in, so it has to have a way out too. */}
          <button type="button" className="vault-link" onClick={() => void signOutUser()}>
            Sign out
          </button>
        </span>
      </header>
      <section className="consent-card vault-card rise rise-1">{children}</section>
    </main>
  );
}

/**
 * Makes a vault, shows its recovery key, and only saves it once the key has
 * been confirmed. A vault whose key nobody kept cannot be opened anywhere
 * else, so the order matters: nothing is sent until the last group is typed.
 */
export function VaultSetup({ reset, onDone }: { reset: boolean; onDone?: () => void }) {
  const vault = useVault();
  const { user } = useAuth();
  const [prepared, setPrepared] = useState<PreparedVault | null>(null);
  const [keyConfirm, setKeyConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { copiedKey, failedKey, copy } = useCopy<"key">();
  const groups = prepared?.recoveryKey.split("-") ?? [];
  const lastGroup = groups.at(-1) ?? "";
  const confirmed = keyConfirm.trim().toUpperCase() === lastGroup && lastGroup !== "";

  async function handlePrepare(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters for your vault password.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("The vault passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      setPrepared(await vault.prepare(reset, password));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not make a vault here.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!prepared) return;
    const text = [
      "shell.online recovery key",
      "",
      prepared.recoveryKey,
      "",
      `Account: ${user?.email ?? ""}`,
      `Made: ${new Date().toISOString().slice(0, 10)}`,
      "",
      "This key opens your session vault in a new browser.",
      "shell.online does not have a copy and cannot recover it.",
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "shell-online-recovery-key.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!prepared || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      await vault.commit(prepared);
      onDone?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your vault.");
      setBusy(false);
    }
  }

  return (
    <>
      <span className="consent-mark" aria-hidden="true">
        <ShieldCheck size={22} />
      </span>
      <h1>{reset ? "Make a new vault" : "Set up your session vault"}</h1>
      <p>
        Every session is end-to-end encrypted with its own password. Your vault
        keeps those passwords sealed, so a session opens on any browser you
        unlock, including ones started in a terminal. shell.online cannot open
        your vault.
      </p>

      {reset && (
        <Alert tone="error">
          Passwords sealed to your old vault can no longer be opened. Running
          sessions this browser can still read move across. Machines linked
          with <code>shell login</code> need to sign in again before they save
          to the new vault.
        </Alert>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {!prepared && (
        <form className="vault-form" onSubmit={handlePrepare}>
          <label className="vault-label" htmlFor="vault-password">Vault password</label>
          <input
            id="vault-password"
            className="vault-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            maxLength={1024}
          />
          <label className="vault-label" htmlFor="vault-password-confirm">Confirm vault password</label>
          <input
            id="vault-password-confirm"
            className="vault-input"
            type="password"
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
            autoComplete="new-password"
            maxLength={1024}
          />
          <p className="vault-note">
            This password unlocks the vault after Google or email sign-in. It never leaves this browser.
          </p>
          <div className="consent-actions">
            <Button type="submit" busy={busy} busyLabel="Creating" disabled={busy}>
              Create vault
            </Button>
          </div>
        </form>
      )}

      {prepared && (
        <form className="vault-form" onSubmit={handleSubmit}>
          <div className="vault-key-block">
            <span className="vault-label">Your recovery key</span>
            <code className="vault-key" aria-label="Recovery key">
              {groups.map((group, index) => (
                <span key={index}>{group}</span>
              ))}
            </code>
            <div className="vault-key-actions">
              <Button type="button" variant="ghost" onClick={() => void copy(prepared.recoveryKey, "key")}>
                {copiedKey === "key" ? <Check size={15} weight="bold" /> : <Copy size={15} />}
                {copiedKey === "key" ? "Copied" : "Copy"}
              </Button>
              <Button type="button" variant="ghost" onClick={download}>
                <DownloadSimple size={15} />
                Download
              </Button>
            </div>
            {failedKey && <p className="vault-note">{COPY_FAILED}</p>}
          </div>

          <p className="vault-note">
            <Key size={14} weight="bold" />
            <span>
              This is the only way into your vault from a new browser. Keep it
              in a password manager or somewhere offline. shell.online does not
              have a copy and cannot recover it for you.
            </span>
          </p>

          <label className="vault-label" htmlFor="vault-confirm">
            Type the last group of four to confirm you saved it
          </label>
          <input
            id="vault-confirm"
            className="vault-input"
            value={keyConfirm}
            onChange={(event) => setKeyConfirm(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={4}
            placeholder="XXXX"
          />

          <div className="consent-actions">
            <Button type="submit" busy={busy} busyLabel="Saving" disabled={!confirmed || busy}>
              {reset ? "Replace my vault" : "Turn on my vault"}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

/** Opens an existing vault in a browser that has not opened it before. */
export function VaultUnlock() {
  const vault = useVault();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"password" | "recovery">(
    vault.unlockMethods.password ? "password" : "recovery",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(false);

  if (resetting) return <VaultSetup reset />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "password") await vault.unlockWithPassword(text);
      else await vault.unlock(text);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not unlock your vault.");
      setBusy(false);
    }
  }

  return (
    <>
      <span className="consent-mark" aria-hidden="true">
        <LockKey size={22} />
      </span>
      <h1>Unlock your session vault</h1>
      <p>
        Use your vault password or passkey. Recovery is only for when both are unavailable.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="vault-unlock-methods" role="group" aria-label="Vault unlock method">
        {vault.unlockMethods.password && (
          <Button
            type="button"
            variant={mode === "password" ? "primary" : "ghost"}
            onClick={() => { setMode("password"); setText(""); setError(""); }}
          >
            <LockKey size={15} /> Password
          </Button>
        )}
        {vault.unlockMethods.passkeys.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await vault.unlockWithPasskey();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "Could not use that passkey.");
                setBusy(false);
              }
            }}
          >
            <Fingerprint size={15} /> Use passkey
          </Button>
        )}
        <Button
          type="button"
          variant={mode === "recovery" ? "primary" : "ghost"}
          onClick={() => { setMode("recovery"); setText(""); setError(""); }}
        >
          <Key size={15} /> Recovery key
        </Button>
      </div>

      <form className="vault-form" onSubmit={handleSubmit}>
        <label className="vault-label" htmlFor="vault-recovery">
          {mode === "password" ? "Vault password" : "Recovery key"}
        </label>
        {/*
          Two lines, so the whole key is in view on a phone: a single line
          scrolled most of it out of sight, which is no way to check it.
        */}
        {mode === "password" ? (
          <input
            id="vault-recovery"
            className="vault-input"
            type="password"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="current-password"
            placeholder="Vault password"
          />
        ) : (
        <textarea
          id="vault-recovery"
          className="vault-input vault-input-wide"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="Paste or type your recovery key"
        />)}
        <div className="consent-actions">
          <Button type="submit" busy={busy} busyLabel="Unlocking" disabled={busy || !text.trim()}>
            {mode === "password" ? "Unlock vault" : "Use recovery key"}
          </Button>
        </div>
      </form>

      <details className="vault-lost">
        <summary>Cannot use any unlock method?</summary>
        <p>
          If your password, passkeys and recovery key are all unavailable, you
          can make a new vault. Passwords sealed only to the old vault cannot
          be opened again. An active session password remains available with{" "}
          <code>shell password &lt;ID&gt;</code> on its owner machine.
        </p>
        <Button type="button" variant="ghost" onClick={() => setResetting(true)}>
          Make a new vault
        </Button>
      </details>
    </>
  );
}
