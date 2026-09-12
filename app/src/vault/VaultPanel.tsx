import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Eye, EyeSlash, Fingerprint, Key, LockKey, ShieldCheck, UsersThree } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { fetchSessions, type Member, type SessionRecord } from "../lib/api";
import { COPY_FAILED, useCopy } from "../lib/clipboard";
import { displayName, findPerson } from "../lib/people";
import { isVaultShare } from "../lib/vault-crypto";
import { useVault } from "./VaultProvider";
import { useTeamKey } from "./TeamKeyProvider";
import { VaultSetup, VaultUnlock } from "./VaultGate";
import { sessionOnline, sessionStateLabel } from "../lib/session-liveness";

/* A revealed password goes back into hiding on its own. */
const REVEAL_MS = 30_000;
const SHORT_LIST = 12;

/**
 * The vault on the Account page: what it is, what it holds, and a way to see
 * any of it.
 *
 * Everything shown here is opened in this browser. The service hands this
 * page only this person's own sealed copies, which it cannot open, and never
 * anyone else's; the team sees none of it.
 */
export function VaultPanel() {
  const vault = useVault();
  const [settingUp, setSettingUp] = useState(false);

  return (
    <section className="vault-panel" aria-labelledby="vault-panel-title">
      <header className="vault-panel-head">
        <span className="vault-panel-mark" aria-hidden="true">
          <ShieldCheck size={18} />
        </span>
        <div>
          <h2 id="vault-panel-title">Session vault</h2>
          <p>
            Every session is end-to-end encrypted with its own password. Your
            personal vault keeps only the session passwords sealed to your account,
            so a session opens on any browser you unlock. It is not shared with your team.
          </p>
        </div>
      </header>

      <p className="vault-panel-private">
        <LockKey size={14} weight="bold" />
        <span>
          Only you can see what is in it. Your team cannot see your vault, and
          shell.online stores it sealed and cannot open it. What this page shows
          is opened here, in this browser.
        </span>
      </p>

      {vault.status === "loading" && <p className="vault-note">Opening your vault</p>}
      {vault.status === "error" && (
        <p className="vault-note">
          {vault.error}{" "}
          <button type="button" className="vault-link" onClick={vault.retry}>
            Try again
          </button>
        </p>
      )}
      {vault.status === "setup" && (
        settingUp ? (
          <div className="vault-panel-unlock"><VaultSetup reset={false} onDone={() => setSettingUp(false)} /></div>
        ) : (
          <div className="vault-panel-actions">
            <p className="vault-note">
              Optional. Without a vault, the CLI still prints every session password and you enter it when opening a terminal.
            </p>
            <Button type="button" onClick={() => setSettingUp(true)}>Set up vault</Button>
          </div>
        )
      )}
      {vault.status === "locked" && (
        <div className="vault-panel-unlock">
          <VaultUnlock />
        </div>
      )}
      {vault.status === "unlocked" && <VaultContents />}
    </section>
  );
}

function VaultContents() {
  const vault = useVault();
  const team = useTeamKey();
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [locking, setLocking] = useState(false);

  useEffect(() => {
    let live = true;
    fetchSessions()
      .then((result) => {
        if (!live) return;
        setSessions(result.sessions);
        setMembers(result.members ?? []);
      })
      .catch((caught) => live && setError(caught instanceof Error ? caught.message : "Could not load your sessions."));
    return () => {
      live = false;
    };
  }, []);

  /* Only v2 copies are in the account vault. Legacy shares belong to one old browser. */
  const held = (sessions ?? []).filter((session) => isVaultShare(session.keyShare?.sealed));
  const legacy = (sessions ?? []).filter(
    (session) => session.keyShare && !isVaultShare(session.keyShare.sealed),
  ).length;
  const running = held.filter(sessionOnline).length;
  const shown = showAll ? held : held.slice(0, SHORT_LIST);

  return (
    <>
      <dl className="vault-facts">
        <div>
          <dt>Key</dt>
          <dd className="vault-fingerprint">{vault.fingerprint}</dd>
        </div>
        {vault.createdAt && (
          <div>
            <dt>Made</dt>
            <dd>{new Date(vault.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</dd>
          </div>
        )}
        <div>
          <dt>This browser</dt>
          <dd>
            {vault.remembered
              ? "Keeps it unlocked until you sign out"
              : "Cannot keep it unlocked, so it asks for a password or passkey each visit"}
          </dd>
        </div>
      </dl>

      <h3 className="vault-panel-subhead">What it holds</h3>
      <ul className="vault-holdings">
        <li>
          <Key size={15} />
          <span>
            <b>
              {sessions === null ? "Session passwords" : `${held.length} session password${held.length === 1 ? "" : "s"}`}
            </b>
            {sessions !== null && held.length > 0 && ` · ${running} for sessions online now`}
            <small>Yours, and the ones teammates shared with you. Listed below.</small>
          </span>
        </li>
        <li>
          <UsersThree size={15} />
          <span>
            <b>Your copy of the team&apos;s audit key</b>
            <small>
              {team.status === "ready"
                ? `Held. It lets you read your team's audit log, which is sealed to it. Key ${team.fingerprint}.`
                : team.status === "waiting"
                  ? "On its way: a teammate's browser seals it to you the next time they open shell.online."
                  : team.status === "error"
                    ? team.error
                    : "Checking."}
            </small>
          </span>
        </li>
      </ul>

      <VaultAccessMethods />

      {error && <p className="vault-note">{error}</p>}

      {sessions !== null && held.length === 0 && (
        <p className="vault-note">
          No session passwords yet. Start or open a session and its password is kept here.
        </p>
      )}
      {legacy > 0 && (
        <p className="vault-note">
          {legacy} older browser-only password {legacy === 1 ? "copy is" : "copies are"} not in this vault.
          They move here only after this browser opens the matching session.
        </p>
      )}

      {held.length > 0 && (
        <ul className="vault-sessions">
          {shown.map((session) => (
            <VaultSessionRow key={session.id} session={session} members={members} you={vault.uid} />
          ))}
        </ul>
      )}
      {held.length > SHORT_LIST && (
        <button type="button" className="vault-link vault-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show fewer" : `Show all ${held.length}`}
        </button>
      )}

      <div className="vault-panel-actions">
        <Button
          type="button"
          variant="ghost"
          busy={locking}
          busyLabel="Locking"
          onClick={async () => {
            setLocking(true);
            await vault.lock();
            setLocking(false);
          }}
        >
          <LockKey size={15} />
          Lock in this browser
        </Button>
        <p className="vault-note">
          Locking forgets the unlocked key here. The vault is untouched, and your
          password, passkey or recovery key opens it again.
        </p>
      </div>
    </>
  );
}

function VaultAccessMethods() {
  const vault = useVault();
  const [recovery, setRecovery] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function addPassword() {
    setError("");
    setNotice("");
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("The vault passwords do not match.");
    setBusy(true);
    try {
      await vault.setPassword(recovery, password);
      setRecovery(""); setPassword(""); setConfirm("");
      setNotice("Vault password saved. You will not need the recovery key for normal unlocks.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the vault password.");
    } finally { setBusy(false); }
  }

  async function addPasskey() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await vault.addPasskey(password);
      setPassword("");
      setNotice("Passkey added. It can unlock this vault without a recovery key.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the passkey.");
    } finally { setBusy(false); }
  }

  return (
    <section className="vault-access" aria-labelledby="vault-access-title">
      <h3 id="vault-access-title" className="vault-panel-subhead">Unlock methods</h3>
      {notice && <p className="vault-note">{notice}</p>}
      {error && <Alert tone="error">{error}</Alert>}
      {!vault.unlockMethods.password ? (
        <div className="vault-form">
          <p className="vault-note">Add a normal password once; keep the recovery key only for emergencies.</p>
          <label className="vault-label" htmlFor="vault-access-recovery">Current recovery key</label>
          <textarea id="vault-access-recovery" className="vault-input vault-input-wide" rows={2} value={recovery} onChange={(e) => setRecovery(e.target.value)} />
          <label className="vault-label" htmlFor="vault-access-password">New vault password</label>
          <input id="vault-access-password" className="vault-input" type="password" autoComplete="new-password" maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} />
          <label className="vault-label" htmlFor="vault-access-confirm">Confirm password</label>
          <input id="vault-access-confirm" className="vault-input" type="password" autoComplete="new-password" maxLength={1024} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button type="button" busy={busy} busyLabel="Saving" disabled={busy || !recovery || !password} onClick={() => void addPassword()}>
            Save vault password
          </Button>
        </div>
      ) : (
        <div className="vault-form">
          <p className="vault-note">
            <LockKey size={14} /> Password enabled
            {vault.unlockMethods.passkeys.length > 0 && ` · ${vault.unlockMethods.passkeys.length} passkey${vault.unlockMethods.passkeys.length === 1 ? "" : "s"}`}
          </p>
          <label className="vault-label" htmlFor="vault-passkey-password">Vault password</label>
          <input id="vault-passkey-password" className="vault-input" type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="button" variant="ghost" busy={busy} busyLabel="Adding passkey" disabled={busy || !password} onClick={() => void addPasskey()}>
            <Fingerprint size={15} /> Add passkey
          </Button>
        </div>
      )}
    </section>
  );
}

function VaultSessionRow({
  session,
  members,
  you,
}: {
  session: SessionRecord;
  members: Member[];
  you: string;
}) {
  const vault = useVault();
  const [password, setPassword] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { copiedKey, failedKey, copy } = useCopy<"password">();
  const timer = useRef<number | null>(null);
  const owner = findPerson(members, session.ownerUid);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function reveal() {
    if (password !== null) {
      setPassword(null);
      return;
    }
    const opened = await vault.openShare(session.id, session.keyShare);
    if (!opened) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setPassword(opened);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPassword(null), REVEAL_MS);
  }

  return (
    <li className="vault-session">
      <div className="vault-session-main">
        <Link to={`/sessions/${session.id}`} className="vault-session-name">
          {session.name || session.command}
        </Link>
        <span className="vault-session-meta">
          {[
            session.host,
            sessionStateLabel(session).toLowerCase(),
            session.ownerUid === you ? "yours" : `shared by ${displayName(owner)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {password !== null && (
          <code className="vault-session-password" aria-label="Session password">
            {password}
          </code>
        )}
        {failed && <span className="vault-note">This browser cannot open that copy.</span>}
        {failedKey && <span className="vault-note">{COPY_FAILED}</span>}
      </div>
      <div className="vault-session-actions">
        <button type="button" className="vault-link" onClick={() => void reveal()}>
          {password !== null ? <EyeSlash size={14} /> : <Eye size={14} />}
          {password !== null ? "Hide" : "Show"}
        </button>
        {password !== null && (
          <button type="button" className="vault-link" onClick={() => void copy(password, "password")}>
            {copiedKey === "password" ? <Check size={14} /> : <Copy size={14} />}
            {copiedKey === "password" ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </li>
  );
}
