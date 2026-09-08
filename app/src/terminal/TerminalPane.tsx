import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowClockwise, LockKey } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { TerminalConnection, type ConnectionStatus } from "./connection";
import { encryptionFragment, resolveSessionSocket, sessionIdFromShareUrl } from "./socket-url";
import { forget, passwordFor } from "../lib/session-passwords";
import { openSealed } from "../lib/keypair";
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
   * but not type, which is what "readable by the organization, editable by
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

export function TerminalPane({
  shareUrl,
  active,
  keyShare,
  canType = true,
}: TerminalPaneProps) {
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const connection = useRef<TerminalConnection | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  /*
   * Only the visible pane measures itself. A hidden one is still laid out, so
   * it would measure fine here, but refusing to refit it at all means no
   * future layout change can quietly resize somebody's running terminal.
   */
  const activeRef = useRef(active);
  activeRef.current = active;

  const refit = useCallback(() => {
    if (!activeRef.current || !fit.current || !terminal.current) return;
    try {
      fit.current.fit();
      connection.current?.resize(terminal.current.cols, terminal.current.rows);
    } catch {
      /* the node can be detached mid-teardown */
    }
  }, []);

  useEffect(() => {
    const node = mount.current;
    if (!node) return;

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
      fontFamily: 'ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(node);
    terminal.current = term;
    fit.current = fitAddon;

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
      },
    });
    connection.current = connected;

    const typed = term.onData((data) => {
      if (!canType) return;
      connected.send(data);
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
      if (keyShare) {
        const shared = await openSealed(keyShare.senderPublicKey, keyShare.sealed);
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
      connected.close();
      term.dispose();
      terminal.current = null;
      fit.current = null;
      connection.current = null;
    };
  }, [shareUrl, refit, canType, keyShare]);

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
    </div>
  );
}
