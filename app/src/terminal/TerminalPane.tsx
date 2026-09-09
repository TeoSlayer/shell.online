import { useCallback, useEffect, useRef, useState, type FormEvent, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { ArrowClockwise, LockKey } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { TerminalConnection, type ConnectionStatus } from "./connection";
import { DESKTOP_TERMINAL_GRID, type TerminalGrid } from "./terminal-grid";
import { fittedTerminal, type TerminalCell } from "./terminal-fit";
import { cellMeasurer, terminalBox } from "./terminal-metrics";
import { encryptionFragment, resolveSessionSocket, sessionIdFromShareUrl } from "./socket-url";
import { forget, passwordFor, rememberFor } from "../lib/session-passwords";
import { openSealed } from "../lib/keypair";
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
   * False for a colleague who is neither owner nor assignee. They can watch
   * but not type, which is what "readable by the team, editable by
   * the people responsible" means in a terminal.
   */
  canType?: boolean;
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
}: TerminalPaneProps) {
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
   * A stable identity for the sealed password.
   *
   * The sessions list is refetched every few seconds and every fetch builds
   * new objects, so the keyShare prop is a different object each time even
   * when the bytes are identical. It is in the dependency list of the effect
   * below, which builds the terminal and opens the socket, so an unstable
   * identity tears the terminal down and reconnects it on every poll. What
   * matters is the content, so that is what is compared.
   */
  const sealed = keyShare ? `${keyShare.senderPublicKey}:${keyShare.sealed}` : "";
  const stableShare = useMemo(
    () => keyShare,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content, not identity
    [sealed],
  );

  useEffect(() => {
    const node = mount.current;
    if (!node) return;

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
          setStatus(next);
          setDetail(message ?? "");
          if (next === "needs-password") {
            setUnlocking(false);
            /*
             * A remembered password that no longer works is worse than none:
             * it would retry forever. Drop it and let the person type one.
             */
            if (message) {
              const id = sessionIdFromShareUrl(shareUrl);
              if (id) forget(id);
            }
          }
        },
        onData: (bytes, reset) => {
          if (reset) term.reset();
          term.write(bytes);
        },
        onReadOnly: (value) => {
          setReadOnly(value);
          term.options.disableStdin = value;
        },
        /* A phone joining takes the session to 80x24, and back when it leaves. */
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
     */
    const audited = sessionIdFromShareUrl(shareUrl);
    const sink = audited ? new AuditSink(audited, postAudit) : null;

    const typed = term.onData((data) => {
      if (!canType) return;
      connected.send(data);
      sink?.observe(data);
    });
    term.options.disableStdin = !canType;

    /*
     * A session this browser started already has its password here, so unlock
     * without a prompt. Everything else still asks.
     */
    const sessionId = sessionIdFromShareUrl(shareUrl);
    void connected.start().then(async () => {
      if (!connected.needsPassword) return;
      /* This browser's own copy, from starting the session here. */
      const own = sessionId ? passwordFor(sessionId) : null;
      if (own) return connected.submitPassword(own);
      /* Otherwise a copy a colleague sealed to this browser. */
      if (stableShare) {
        const shared = await openSealed(stableShare.senderPublicKey, stableShare.sealed);
        if (shared) return connected.submitPassword(shared);
      }
    });

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
  }, [shareUrl, refit, canType, stableShare]);

  /* A hidden pane measures as zero, so it has to be refitted when it returns. */
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      refit();
      if (!readOnly) terminal.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, readOnly, refit]);

  async function handleUnlock(event: FormEvent) {
    event.preventDefault();
    if (!password || !connection.current) return;
    setUnlocking(true);
    setDetail("");
    /*
     * Kept, so this is the last time it is typed for this session.
     *
     * A password only proves itself when a frame opens, which happens after
     * this returns, so it is written now and removed by the failure path
     * above if it turns out to be wrong. Storing it early costs a dead entry;
     * not storing it at all is what made every reload ask again.
     */
    const sessionId = sessionIdFromShareUrl(shareUrl);
    if (sessionId) rememberFor(sessionId, password);
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
              The password is used on this device to derive the key. It is never
              sent to shell.online.
            </p>
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
        <div className="pane-banner pane-watching">Watching. Only the owner and assignee can type.</div>
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
