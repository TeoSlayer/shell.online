import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Eye, EyeSlash, Key, LockKey, ShieldCheck, UsersThree } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { fetchSessions, type Member, type SessionRecord } from "../lib/api";
import { COPY_FAILED, useCopy } from "../lib/clipboard";
import { displayName, findPerson } from "../lib/people";
import { isVaultShare } from "../lib/vault-crypto";
import { useVault } from "./VaultProvider";
import { useTeamKey } from "./TeamKeyProvider";
import { VaultUnlock } from "./VaultGate";

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
            vault keeps the passwords of the sessions you can open, sealed to a
            key only you hold, so a session opens on any browser you unlock.
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
        <p className="vault-note">
          You have not set it up yet. <Link to="/sessions">Open Sessions</Link> to set it up; it
          takes a minute and shows you a recovery key to keep.
        </p>
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

  /* The copies sealed to this person: to their vault, or to an old browser key. */
  const held = (sessions ?? []).filter((session) => Boolean(session.keyShare));
  const running = held.filter((session) => !session.closedAt).length;
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
              : "Cannot keep it unlocked, so it asks for your recovery key each visit"}
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
            {sessions !== null && held.length > 0 && ` · ${running} for sessions still running`}
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

      {error && <p className="vault-note">{error}</p>}

      {sessions !== null && held.length === 0 && (
        <p className="vault-note">
          No session passwords yet. Start or open a session and its password is kept here.
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
          recovery key opens it again.
        </p>
      </div>
    </>
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
  const legacy = !isVaultShare(session.keyShare?.sealed);

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
            session.closedAt ? "finished" : "running",
            session.ownerUid === you ? "yours" : `shared by ${displayName(owner)}`,
            legacy ? "sealed to an old browser key; moves into your vault when you open it" : "",
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
