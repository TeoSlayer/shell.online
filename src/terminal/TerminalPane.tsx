import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowClockwise, LockKey } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { TerminalConnection, type ConnectionStatus } from "./connection";
import { encryptionFragment, resolveSessionSocket } from "./socket-url";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";

export interface TerminalPaneProps {
  shareUrl: string;
  /** Hidden panes stay mounted so switching tabs does not drop the socket. */
  active: boolean;
}

const THEME = {
  background: "#00000000",
  foreground: "#dfe2d6",
  cursor: "#c8ff4d",
  selectionBackground: "#3a3f33",
};

export function TerminalPane({ shareUrl, active }: TerminalPaneProps) {
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const connection = useRef<TerminalConnection | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const refit = useCallback(() => {
    if (!fit.current || !terminal.current) return;
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
          if (next === "needs-password") setUnlocking(false);
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

    const typed = term.onData((data) => connected.send(data));
    void connected.start();

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
  }, [shareUrl, refit]);

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

      {status === "disconnected" && (
        <div className="pane-banner">
          <ArrowClockwise size={14} />
          Reconnecting
        </div>
      )}
    </div>
  );
}
