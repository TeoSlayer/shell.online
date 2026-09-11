import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, DownloadSimple, Key, LockKey, ShieldCheck, Warning } from "@phosphor-icons/react";
import { Wordmark } from "../components/Wordmark";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { Booting } from "../components/Booting";
import { useAuth } from "../auth/AuthProvider";
import { COPY_FAILED, useCopy } from "../lib/clipboard";
import { useVault, type PreparedVault } from "./VaultProvider";

/**
 * Stands in front of everything that reads or seals a session password.
 *
 * The vault is required. Without one a session's password lives in a single
 * browser again, and a session started in a terminal cannot open here without
 * someone typing its password. So setting it up is a one-time step on the way
 * to the sessions page, not an option somewhere in settings.
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
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { copiedKey, failedKey, copy } = useCopy<"key">();
  const started = useRef(false);

  useEffect(() => {
    /* Once: a second key pair would silently replace the key being shown. */
    if (started.current) return;
    started.current = true;
    vault
      .prepare(reset)
      .then(setPrepared)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not make a vault here."));
  }, [vault, reset]);

  const groups = prepared?.recoveryKey.split("-") ?? [];
  const lastGroup = groups.at(-1) ?? "";
  const confirmed = confirm.trim().toUpperCase() === lastGroup && lastGroup !== "";

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
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
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
      await vault.unlock(text);
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
        This browser has not opened your vault yet. Enter the recovery key you
        saved when you set it up. The key is used here to open the vault and is
        never sent to shell.online.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      <form className="vault-form" onSubmit={handleSubmit}>
        <label className="vault-label" htmlFor="vault-recovery">
          Recovery key
        </label>
        {/*
          Two lines, so the whole key is in view on a phone: a single line
          scrolled most of it out of sight, which is no way to check it.
        */}
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
        />
        <div className="consent-actions">
          <Button type="submit" busy={busy} busyLabel="Unlocking" disabled={busy || !text.trim()}>
            Unlock
          </Button>
        </div>
      </form>

      <details className="vault-lost">
        <summary>Lost your recovery key?</summary>
        <p>
          You can make a new vault. Passwords sealed to the old one cannot be
          opened again, which is what keeps them out of anyone else&apos;s reach
          too. A session that is still running can be reopened with{" "}
          <code>shell sessions</code> on the machine running it.
        </p>
        <Button type="button" variant="ghost" onClick={() => setResetting(true)}>
          Make a new vault
        </Button>
      </details>
    </>
  );
}
