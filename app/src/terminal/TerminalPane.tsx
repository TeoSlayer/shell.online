import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { ArrowClockwise, LockKey } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { TerminalConnection, type ConnectionStatus } from "./connection";
import { DESKTOP_TERMINAL_GRID, type TerminalGrid } from "./terminal-grid";
import { fittedTerminal, type TerminalCell } from "./terminal-fit";
import { cellMeasurer, terminalBox } from "./terminal-metrics";
import { encryptionFragment, resolveSessionSocket, sessionIdFromShareUrl } from "./socket-url";
import { cachedPassword, forgetUnverified, markVerified, rememberVerified } from "../lib/session-passwords";
import { isVaultShare } from "../lib/vault-crypto";
import { useVault } from "../vault/VaultProvider";
import { useTeamKey } from "../vault/TeamKeyProvider";
import { AuditSink } from "./audit-sink";
import { postAudit } from "../lib/api";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";

export interface TerminalPaneProps {
  shareUrl: string;
  /** Hidden panes stay mounted so switching tabs does not drop the socket. */
  active: boolean;
  /** The password sealed to this browser by whoever started the session. */
  keyShare?: { senderPublicKey: string; sealed: string };
  /**
   * False for a colleague who is neither owner nor an assignee. They can watch
   * but not type, which is what "readable by the team, editable by
   * the people responsible" means in a terminal.
   */
  canType?: boolean;
  /** The machine running it, named in the hint when no password is at hand. */
  host?: string;
}

/*
 * One password to try, and where it came from. The source decides what a
 * failure means: a password this browser only cached as a guess can be
 * dropped, while one from the vault, or one that has worked before, is kept.
 */
interface Attempt {
  source: "vault" | "cache" | "legacy" | "typed";
  password: string;
}

const THEME = {
  background: "#00000000",
  foreground: "#dfe2d6",
  cursor: "#c8ff4d",
  selectionBackground: "#3a3f33",
};

const FONT_FAMILY = 'ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace';

/* Only until the first fit, which is one frame later. Nothing else reads it. */
const BASE_FONT_SIZE = 13;

/*
 * The loosest the rows are ever drawn. A pane with height to spare uses it; a
 * pane that is short for the grid tightens towards the font's own line box,
 * which is what buys the columns a larger font.
 */
const BASE_LINE_HEIGHT = 1.35;

export function TerminalPane({
  shareUrl,
  active,
  keyShare,
  canType = true,
  host,
}: TerminalPaneProps) {
  /*
   * Read through a ref inside the effect that builds the terminal, so the
   * vault changing state never tears down an open session.
   */
  const vault = useVault();
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  /* The team's audit key, for sealing what is typed here; read the same way. */
  const team = useTeamKey();
  const teamRef = useRef(team);
  teamRef.current = team;
  /* The password being tried, and the ones still to try after it. */
  const attempt = useRef<Attempt | null>(null);
  const pending = useRef<Attempt[]>([]);
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const measure = useRef<((fontSize: number) => TerminalCell) | null>(null);
  const connection = useRef<TerminalConnection | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  /*
   * Assignment can change while this pane is open. Read the current answer
   * from a ref inside xterm's long-lived input callback, rather than rebuilding
   * the terminal and dropping its socket and scrollback on every handoff.
   */
  const canTypeRef = useRef(canType);
  canTypeRef.current = canType;

  /*
   * Only the visible pane measures itself. A hidden one is still laid out, so
   * it would measure fine here, but refusing to refit it at all means no
   * future layout change can quietly restyle somebody's running terminal.
   */
  const activeRef = useRef(active);
  activeRef.current = active;

  /*
   * The grid the process is running at, not the grid this pane could fit. The
   * relay announces it and the CLI opens the PTY at it; a viewer's only say in
   * the matter is how large to draw it.
   */
  const grid = useRef<TerminalGrid>(DESKTOP_TERMINAL_GRID);

  /**
   * Draws the whole session grid as large as this pane allows, then pins the
   * terminal to that grid.
   *
   * The obvious thing — FitAddon.fit() — is wrong here. It picks the grid that
   * fills the pane at a fixed font size, so a pane narrower than 120 columns
   * renders a 120-column process at, say, 94: every long line wraps a second
   * time and full-screen output loses its bottom rows. Nothing downstream can
   * repair that, because the PTY is not the size the emulator thinks it is.
   * What the pane may choose is the font and the leading, which is what the
   * fit returns.
   */
  const refit = useCallback(() => {
    const term = terminal.current;
    const node = mount.current;
    const measureCell = measure.current;
    if (!activeRef.current || !term || !node || !measureCell) return;
    try {
      const box = terminalBox(node);
      if (box.width === 0 || box.height === 0) return;
      const { cols, rows } = grid.current;
      const fitted = fittedTerminal(box, { cols, rows }, measureCell, {
        pixelRatio: window.devicePixelRatio,
        maxLineHeight: BASE_LINE_HEIGHT,
      });
      if (term.options.fontSize !== fitted.fontSize) term.options.fontSize = fitted.fontSize;
      if (term.options.lineHeight !== fitted.lineHeight) {
        term.options.lineHeight = fitted.lineHeight;
      }
      if (term.cols !== cols || term.rows !== rows) {
        term.resize(cols, rows);
      } else {
        term.refresh(0, term.rows - 1);
      }
    } catch {
      /* the node can be detached mid-teardown */
    }
  }, []);

  /*
   * The sealed password, read when the terminal is built rather than being a
   * reason to build it again. The session list is refetched every few
   * seconds, and a copy saved to the vault has different bytes every time it
   * is sealed, so rebuilding on a change tore an open terminal down and put
   * it back, scrollback and all. A share that arrives while the pane is still
   * asking for a password is picked up by the effect after the one below.
   */
  const shareRef = useRef(keyShare);
  shareRef.current = keyShare;
  const sealed = keyShare ? `${keyShare.senderPublicKey}:${keyShare.sealed}` : "";
  /* Shares already tried in this pane, so one that does not open is not tried in a loop. */
  const tried = useRef(new Set<string>());

  useEffect(() => {
    const node = mount.current;
    if (!node) return;
    tried.current = new Set();

    /* A pane reused for another session starts from the default again. */
    grid.current = DESKTOP_TERMINAL_GRID;

    const resolved = resolveSessionSocket(
      shareUrl,
      window.location.origin,
      import.meta.env.VITE_RELAY_URL,
    );
    if (!resolved.ok) {
      setStatus("error");
      setDetail(resolved.reason);
      return;
    }
    const target = resolved.target;

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: BASE_FONT_SIZE,
      /* Opened at the session grid so the first frames land in the right shape. */
      cols: grid.current.cols,
      rows: grid.current.rows,
      lineHeight: BASE_LINE_HEIGHT,
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: true,
      scrollback: 5000,
      theme: THEME,
    });
    term.open(node);
    terminal.current = term;
    measure.current = cellMeasurer(FONT_FAMILY);

    const connected = new TerminalConnection({
      url: target.url,
      fragment: encryptionFragment(shareUrl),
      events: {
        onStatus: (next, message) => {
          let shown = message;
          if (next === "needs-password" && message) {
            /*
             * An attempt failed. Only a cached guess is thrown away. A
             * password from the vault, or one that has opened this session
             * before, is kept: a frame can fail to open for reasons other than
             * a wrong password, and deleting the only copy of a right one is
             * how sessions used to be lost for good. A typed password was
             * never written, so there is nothing of it to remove.
             */
            const failed = attempt.current;
            attempt.current = null;
            if (failed && sessionId && failed.source === "cache") {
              forgetUnverified(sessionId, failed.password);
            }
            /* Another source may still hold the right one. */
            if (tryNext()) return;
            if (failed && failed.source !== "typed") {
              shown = "The saved password did not open this session. Enter it to continue.";
            }
          }
          setStatus(next);
          setDetail(shown ?? "");
          if (next === "needs-password") setUnlocking(false);
        },
        onUnlocked: () => {
          const worked = attempt.current;
          attempt.current = null;
          pending.current = [];
          if (!worked || !sessionId) return;
          /* Written only now that it has proved itself; see handleUnlock. */
          if (worked.source === "typed" || worked.source === "vault") {
            /* Also replaces a locally verified password from before rotation. */
            rememberVerified(sessionId, worked.password, shareUrl);
          }
          if (worked.source === "cache") markVerified(sessionId, worked.password, shareUrl);
          /*
           * A password that opened the session but did not come from the
           * vault goes into it now, so no browser has to be told it again.
           * That includes one a colleague sealed to this browser's old key.
           */
          if (worked.source !== "vault") void keepIfMissing(sessionId, worked.password);
        },
        onData: (bytes, reset) => {
          if (reset) term.reset();
          term.write(bytes);
        },
        onReadOnly: (value) => {
          setReadOnly(value);
          term.options.disableStdin = value || !canTypeRef.current;
        },
        /* A portrait viewer takes a capable session to 80x40, and back when it leaves. */
        onGrid: (next) => {
          grid.current = next;
          refit();
        },
      },
    });
    connection.current = connected;

    /*
     * Input is recorded per session so a team can see what was run
     * or asked. It watches the same stream the terminal receives, so it sees
     * exactly what was entered and nothing else.
     *
     * Each entry is sealed here to the team's audit key before it leaves the
     * browser, so the team can read it and the service cannot. The time is
     * part of what is sealed, so it is fixed before sealing and sent as is.
     */
    const audited = sessionIdFromShareUrl(shareUrl);
    const sink = audited
      ? new AuditSink(audited, async (entries) =>
          postAudit(
            await Promise.all(
              entries.map(async (entry) => ({
                ...entry,
                text: await teamRef.current.sealAudit({
                  sessionId: entry.session_id,
                  kind: entry.kind,
                  at: entry.at,
                  text: entry.text,
                }),
              })),
            ),
          ),
        )
      : null;

    const typed = term.onData((data) => {
      if (!canTypeRef.current) return;
      connected.send(data);
      sink?.observe(data);
    });
    term.options.disableStdin = !canTypeRef.current;

    const sessionId = sessionIdFromShareUrl(shareUrl);
    attempt.current = null;
    pending.current = [];

    /* Submits the next password to try. False when none is left. */
    function tryNext(): boolean {
      const next = pending.current.shift();
      if (!next) return false;
      attempt.current = next;
      void connected.submitPassword(next.password);
      return true;
    }

    /*
     * Every password within reach is tried before anyone is asked. One this
     * The current vault copy goes first. A password cached as verified may
     * belong to the credential generation before a live rotation; "worked in
     * the past" is not proof that it is current. Then a cached password, then
     * one a colleague sealed to this browser's old key. The gate appears only
     * when all of them fail, or there are none.
     */
    const initial = shareRef.current;
    if (initial) tried.current.add(`${initial.senderPublicKey}:${initial.sealed}`);
    void connected.start().then(async () => {
      if (!connected.needsPassword || !sessionId) return;
      const found: Attempt[] = [];
      const add = (source: Attempt["source"], password: string | null | undefined) => {
        if (password && !found.some((entry) => entry.password === password)) found.push({ source, password });
      };
      const opener = vaultRef.current;
      const cached = cachedPassword(sessionId);
      if (initial && isVaultShare(initial.sealed)) add("vault", await opener.openShare(sessionId, initial));
      add("cache", cached?.password);
      if (initial && !isVaultShare(initial.sealed)) add("legacy", await opener.openShare(sessionId, initial));
      pending.current = found;
      tryNext();
    });

    /*
     * Seals a password that worked into the vault, unless the vault already
     * holds exactly this one. Sealing is never byte-for-byte repeatable, so
     * doing it regardless would rewrite the share on every open. Only a vault
     * share counts as held: one sealed to an old browser key is the thing
     * being moved into the vault.
     */
    async function keepIfMissing(id: string, password: string): Promise<void> {
      const opener = vaultRef.current;
      const share = shareRef.current;
      if (share && isVaultShare(share.sealed) && (await opener.openShare(id, share)) === password) return;
      await opener.keep(id, password);
    }

    const observer = new ResizeObserver(() => refit());
    observer.observe(node);
    const frame = requestAnimationFrame(refit);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      typed.dispose();
      sink?.close();
      connected.close();
      term.dispose();
      terminal.current = null;
      measure.current = null;
      connection.current = null;
    };
  }, [shareUrl, refit]);

  /*
   * Apply a handoff in place. The relay's own read-only bit still wins, and
   * the callback above checks the same ref as a second guard against input
   * arriving between a render and this effect.
   */
  useEffect(() => {
    canTypeRef.current = canType;
    if (!terminal.current) return;
    terminal.current.options.disableStdin = readOnly || !canType;
  }, [canType, readOnly]);

  /*
   * A share that arrives while the pane is asking for a password, such as the
   * CLI's own copy landing a moment after the session appears, is tried
   * without anyone having to reload. Each share is tried once.
   */
  useEffect(() => {
    const share = shareRef.current;
    const id = sessionIdFromShareUrl(shareUrl);
    if (status !== "needs-password" || !share || !id || attempt.current) return;
    const key = `${share.senderPublicKey}:${share.sealed}`;
    if (tried.current.has(key)) return;
    tried.current.add(key);
    void vaultRef.current.openShare(id, share).then((password) => {
      if (!password || !connection.current || attempt.current) return;
      pending.current = [];
      attempt.current = { source: isVaultShare(share.sealed) ? "vault" : "legacy", password };
      void connection.current.submitPassword(password);
    });
  }, [sealed, status, shareUrl]);

  /* A hidden pane measures as zero, so it has to be refitted when it returns. */
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      refit();
      if (!readOnly && canType) terminal.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, readOnly, canType, refit]);

  async function handleUnlock(event: FormEvent) {
    event.preventDefault();
    if (!password || !connection.current) return;
    setUnlocking(true);
    setDetail("");
    /*
     * Nothing is written until the password opens the session. Then it is
     * cached as proven and sealed into the vault, so this is the last time it
     * is typed for this session in any browser. A typo is simply forgotten,
     * and never takes the place of a password that works.
     */
    pending.current = [];
    attempt.current = { source: "typed", password };
    await connection.current.submitPassword(password);
    setPassword("");
  }

  const locked = status === "needs-password";

  return (
    <div className="pane" data-active={active} aria-hidden={!active}>
      <div className="pane-screen" ref={mount} />

      {locked && (
        <div className="pane-gate">
          <form className="pane-gate-card" onSubmit={handleUnlock}>
            <span className="pane-gate-mark" aria-hidden="true">
              <LockKey size={20} />
            </span>
            <h2>Enter the session password</h2>
            <p>
              The password is used on this device to derive the key. Once it
              opens the session it is sealed into your vault, which shell.online
              cannot open, and you are not asked for it again.
            </p>
            {host && (
              <p className="pane-gate-hint">
                Started in a terminal on <b>{host}</b>? Running{" "}
                <code>shell sessions</code> there shows its password.
              </p>
            )}
            {detail && <Alert tone="error">{detail}</Alert>}
            <label htmlFor={`pw-${shareUrl}`}>Password</label>
            <input
              id={`pw-${shareUrl}`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={unlocking}
              autoFocus={active}
            />
            <Button type="submit" busy={unlocking} busyLabel="Decrypting">
              Decrypt terminal
            </Button>
          </form>
        </div>
      )}

      {(status === "ended" || status === "missing" || status === "error") && (
        <div className="pane-gate">
          <div className="pane-gate-card">
            <h2>
              {status === "ended"
                ? "This session has ended."
                : status === "missing"
                  ? "This session is no longer available."
                  : "This session cannot be opened."}
            </h2>
            <p>
              {detail ||
                (status === "ended"
                  ? "The process exited and its link closed."
                  : "It may have expired, or the link may be wrong.")}
            </p>
          </div>
        </div>
      )}

      {!canType && status === "connected" && (
        <div className="pane-banner pane-watching">Watching. Only the owner and assignees can type.</div>
      )}

      {status === "disconnected" && (
        <div className="pane-banner">
          <ArrowClockwise size={14} />
          Reconnecting
        </div>
      )}

      {status === "full" && (
        <div className="pane-banner">
          <ArrowClockwise size={14} />
          {detail || "Session full. Waiting for a viewer slot."}
        </div>
      )}
    </div>
  );
}
