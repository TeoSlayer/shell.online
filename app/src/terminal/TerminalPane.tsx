import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowClockwise, CheckCircle, HourglassMedium, Key, LockKey } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import "../../../web/vendor/refstream/v0.1.0-alpha.5/refstream.css";
import "../../../web/vendor/refstream/v0.1.0-alpha.5/ui.css";
import { TerminalConnection, type ConnectionStatus, type HostState } from "./connection";
import { hostIsAway, hostNotice } from "./host-presence";
import { DESKTOP_TERMINAL_GRID, type TerminalGrid } from "./terminal-grid";
import { fittedTerminal, type TerminalCell } from "./terminal-fit";
import { cellMeasurer, terminalBox } from "./terminal-metrics";
import { encryptionFragment, resolveSessionSocket, sessionIdFromShareUrl } from "./socket-url";
import { cachedPassword, forgetUnverified, markVerified, rememberVerified } from "../lib/session-passwords";
import { isVaultShare } from "../lib/vault-crypto";
import { useVault } from "../vault/VaultProvider";
import { VaultUnlock } from "../vault/VaultGate";
import { useTeamKey } from "../vault/TeamKeyProvider";
import { AuditSink } from "./audit-sink";
import { postAudit, type SessionRecord } from "../lib/api";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { FeedbackLink } from "../feedback/FeedbackLink";
import { createTerminal, type TerminalRenderer, type TerminalSurface } from "./renderer";
import { attachTouchScroll } from "./touch-scroll";
import { TerminalWriteQueue } from "../../../web/terminal-writes";
import { PulseObserver } from "./pulse-observer";
import type { SessionPulse } from "./session-pulse";
import { SessionPulseBadge } from "./SessionPulse";
import { attachRefstreamTools } from "../../../web/refstream-tools";
import { mountTerminalPaste } from "../../../web/terminal-paste";
import "../../../web/terminal-paste.css";
import { RelayFileClient } from "../../../web/relay-files";
import { mountRelayFileBrowser } from "../../../web/relay-files-ui";
import "../../../web/relay-files.css";

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
  /** Browser renderer selected for every open session in this workspace. */
  renderer: TerminalRenderer;
  /** Passive, memory-only metadata from this viewer's existing decrypted stream. */
  onPulseChange?: (pulse: SessionPulse | null) => void;
  pulseAllowed?: boolean;
  /** Workspace puts this action beside the renderer, never over terminal cells. */
  onPasteReady?: (open: (() => void) | null) => void;
  /**
   * Asks the session's owner for the password, from the password prompt.
   * Absent for the owner, and for a session opened outside a team.
   */
  onRequestPassword?: () => Promise<void>;
  /** Where this person's own ask stands, from the session list. */
  passwordRequest?: SessionRecord["passwordRequest"];
  /** Who is being asked, by name. */
  ownerName?: string;
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

/*
 * The terminal is drawn on the page itself, so its palette is the app's: ink
 * on paper in the light theme, and shell.online's terminal colors in the dark.
 * Use the page's actual background colour: reverse video swaps it into the
 * foreground, so transparent black would make text disappear on dark bars.
 */
const DARK_THEME = {
  background: "#161914",
  foreground: "#dfe2d6",
  cursor: "#c8ff4d",
  cursorAccent: "#161914",
  selectionBackground: "#3a3f33",
};

/*
 * The standard ANSI colors assume a dark background: "white" and the bright
 * yellows and cyans vanish on paper. Each is darkened to the app's own ink
 * weights so programs that pick colors themselves stay legible.
 */
const LIGHT_THEME = {
  background: "#f3f1e9",
  foreground: "#191b18",
  cursor: "#191b18",
  cursorAccent: "#f3f1e9",
  selectionBackground: "#d4dbf8",
  black: "#191b18",
  red: "#b3261e",
  green: "#2f6d29",
  yellow: "#855d00",
  blue: "#294ec8",
  magenta: "#8a3aa3",
  cyan: "#17707a",
  white: "#686c63",
  brightBlack: "#5d6158",
  brightRed: "#c9402f",
  brightGreen: "#3b8233",
  brightYellow: "#9a6c00",
  brightBlue: "#4267f5",
  brightMagenta: "#a04dba",
  brightCyan: "#1f8591",
  brightWhite: "#3a3e37",
};

/*
 * All renderers need a real background colour for reverse-video output.
 */
function terminalTheme(_renderer: TerminalRenderer, dark: boolean) {
  return dark ? DARK_THEME : LIGHT_THEME;
}

/* Mirrors tokens.css: an explicit data-theme wins, otherwise the system's. */
function appPrefersDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

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
  renderer,
  onPulseChange,
  pulseAllowed = true,
  onPasteReady,
  onRequestPassword,
  passwordRequest,
  ownerName,
}: TerminalPaneProps) {
  const pasteReady = useRef(onPasteReady);
  pasteReady.current = onPasteReady;
  const [pulse, setPulse] = useState<SessionPulse | null>(null);
  const pulseObserver = useRef<PulseObserver | null>(null);
  const pulseCallback = useRef(onPulseChange);
  pulseCallback.current = onPulseChange;
  const pulseAllowedRef = useRef(pulseAllowed);
  pulseAllowedRef.current = pulseAllowed;
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
  const toolsMount = useRef<HTMLDivElement>(null);
  const filesMount = useRef<HTMLDivElement>(null);
  const pasteMount = useRef<HTMLDivElement>(null);
  const pasteUi = useRef<ReturnType<typeof mountTerminalPaste> | null>(null);
  const terminal = useRef<TerminalSurface | null>(null);

  /* The palette follows the app theme, including a change while the pane is open. */
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      if (terminal.current) terminal.current.options.theme = terminalTheme(renderer, appPrefersDark());
    };
    media?.addEventListener("change", apply);
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media?.removeEventListener("change", apply);
      observer.disconnect();
    };
  }, [renderer]);
  const measure = useRef<((fontSize: number) => TerminalCell) | null>(null);
  const connection = useRef<TerminalConnection | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [detail, setDetail] = useState("");
  /*
   * The machine's own state, reported by the relay. It is not this viewer's
   * connection: a pane can be fully connected to a session whose machine is
   * asleep, and saying nothing about that is how a terminal appears to be
   * missing rather than paused.
   */
  const [hostState, setHostState] = useState<HostState | null>(null);
  const [mcpAuthorized, setMcpAuthorized] = useState(false);
  const [hasScreen, setHasScreen] = useState(false);
  /* Re-read on a timer so "4 minutes ago" keeps being true on an idle page. */
  const [now, setNow] = useState(() => Date.now());
  const [readOnly, setReadOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const [unlockMethod, setUnlockMethod] = useState<"vault" | "password" | null>(null);
  const lastVaultStatus = useRef(vault.status);

  /* Ticks only while the machine is away, and only to keep "ago" honest. */
  useEffect(() => {
    if (!hostIsAway(hostState?.presence)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [hostState?.presence, hostState?.lastSeenAt]);

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

  useEffect(() => {
    pulseObserver.current?.visibility(active && !document.hidden);
    pulseObserver.current?.tick(Date.now());
  }, [active]);

  useEffect(() => {
    pulseObserver.current?.authorization(pulseAllowed);
  }, [pulseAllowed]);

  /*
   * The grid the process is running at, not the grid this pane could fit. The
   * relay announces it and the CLI opens the PTY at it; a viewer's only say in
   * the matter is how large to draw it.
   */
  const grid = useRef<TerminalGrid>(DESKTOP_TERMINAL_GRID);
  const fontScale = useRef(1);
  const fittedFontSize = useRef(BASE_FONT_SIZE);

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
      fittedFontSize.current = fitted.fontSize;
      /* The shared fit may go to 4 for a narrow pane; clamping higher clips the grid. */
      const scaledFontSize = Math.max(4, Math.min(32, fitted.fontSize * fontScale.current));
      if (term.options.fontSize !== scaledFontSize) term.options.fontSize = scaledFontSize;
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
    const toolsNode = toolsMount.current;
    const filesNode = filesMount.current;
    if (!node || !toolsNode || !filesNode) return;
    let connectionStatus: ConnectionStatus = "connecting";
    tried.current = new Set();

    /* A pane reused for another session starts from the default again. */
    grid.current = DESKTOP_TERMINAL_GRID;
    fontScale.current = 1;
    fittedFontSize.current = BASE_FONT_SIZE;

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
    const sessionId = sessionIdFromShareUrl(shareUrl);

    const term = createTerminal(renderer, {
      fontFamily: FONT_FAMILY,
      fontSize: BASE_FONT_SIZE,
      /* Opened at the session grid so the first frames land in the right shape. */
      cols: grid.current.cols,
      rows: grid.current.rows,
      lineHeight: BASE_LINE_HEIGHT,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: terminalTheme(renderer, appPrefersDark()),
    });
    term.open(node);
    terminal.current = term;
    /* Phones send no wheel events; a drag stands in for one. */
    const touchScroll = attachTouchScroll(node, term);
    measure.current = cellMeasurer(FONT_FAMILY);

    let connected: TerminalConnection;
    const fileClient = new RelayFileClient((frame) => connected.sendFrame(frame));
    if (renderer === "refstream") term.options.fileLinks = fileClient.fileLinks;

    const pane = node.closest<HTMLElement>(".pane");
    const fileBrowser = pane ? mountRelayFileBrowser(fileClient, filesNode, pane) : null;
    let rendererTools: { dispose(): void } | null = null;
    let rendererToolsDisposed = false;
    if (pane) {
      void attachRefstreamTools(renderer, {
        terminal: term,
        toolbar: toolsNode,
        overlay: pane,
        frame: pane,
        isActive: () => activeRef.current,
        onFontSizeChange: (size) => {
          fontScale.current = size / Math.max(fittedFontSize.current, 1);
          refit();
        },
        exportFilename: "shell-online-terminal-output.txt",
      }).then((tools) => {
        if (rendererToolsDisposed) tools?.dispose();
        else rendererTools = tools;
      });
    }

    let snapshotGeneration = 0;
    let rendererInputSuppressed = false;
    const terminalWrites = new TerminalWriteQueue(term, 64 * 1024);
    let snapshotRequestPending = false;
    const observerPulse = new PulseObserver((value) => {
      setPulse(value);
      pulseCallback.current?.(value);
    });
    pulseObserver.current = observerPulse;
    const updatePulse = () => {
      observerPulse.authorization(pulseAllowedRef.current);
      observerPulse.visibility(activeRef.current && !document.hidden);
      observerPulse.tick(Date.now());
    };
    updatePulse();
    const pulseTimer = window.setInterval(updatePulse, 1000);
    document.addEventListener("visibilitychange", updatePulse);
    connected = new TerminalConnection({
      url: target.url,
      fragment: encryptionFragment(shareUrl),
      events: {
        onStatus: (next, message) => {
          connectionStatus = next;
          observerPulse.connection(next === "connected");
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
          if (next === "connected") fileClient.probe();
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
        onHostState: (next) => {
          setHostState(next);
          observerPulse.host(next.presence === "connected");
        },
        onMcpAuthorization: setMcpAuthorized,
        onData: (bytes, reset) => {
          if (pulseAllowedRef.current) observerPulse.feed(bytes, reset, Date.now());
          if (bytes.byteLength > 0) setHasScreen(true);
          if (!reset) {
            if (!terminalWrites.enqueue(bytes) && !snapshotRequestPending) {
              snapshotRequestPending = true;
              connected.requestSnapshot();
            }
            return;
          }
          const generation = ++snapshotGeneration;
          rendererInputSuppressed = true;
          snapshotRequestPending = false;
          // reset() is synchronous but write() is not. Serialize the reset
          // behind any in-progress write, as the standalone viewer does.
          terminalWrites.enqueue(bytes, true, () => {
            if (generation === snapshotGeneration) rendererInputSuppressed = false;
          });
        },
        onFileFrame: (frame) => { fileClient.handle(frame); },
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
      if (!canTypeRef.current || rendererInputSuppressed) return;
      connected.send(data);
      sink?.observe(data);
    });
    const pasteTools = renderer !== "chat" && pasteMount.current ? mountTerminalPaste({
      toolbar: pasteMount.current,
      overlay: node.parentElement!,
      canPaste: () => activeRef.current && connectionStatus === "connected" && canTypeRef.current && !term.options.disableStdin && !rendererInputSuppressed,
      paste: (text) => term.paste?.(text),
    }) : null;
    pasteUi.current = pasteTools;
    pasteReady.current?.(pasteTools?.open ?? null);
    /*
     * Legacy mouse protocols (X10/VT200 without SGR) and a few device query
     * responses emit raw bytes via onBinary, not onData. Without this an
     * alt-screen TUI's wheel/pointer reports are silently dropped. The same
     * access gate as onData applies; raw bytes are not observed (they are not
     * user text) and must not pass through UTF-8 encoding.
     */
    const binary = term.onBinary?.((data) => {
      if (!canTypeRef.current || rendererInputSuppressed) return;
      connected.sendBinary(data);
    });
    term.options.disableStdin = !canTypeRef.current;

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
      window.clearInterval(pulseTimer);
      pasteTools?.dispose();
      pasteUi.current = null;
      pasteReady.current?.(null);
      document.removeEventListener("visibilitychange", updatePulse);
      observerPulse.dispose();
      pulseObserver.current = null;
      rendererToolsDisposed = true;
      rendererTools?.dispose();
      cancelAnimationFrame(frame);
      observer.disconnect();
      typed.dispose();
      binary?.dispose();
      touchScroll.dispose();
      sink?.close();
      connected.close();
      fileClient.dispose();
      fileBrowser?.dispose();
      term.dispose();
      terminal.current = null;
      measure.current = null;
      connection.current = null;
    };
  }, [shareUrl, renderer, refit]);

  useEffect(() => {
    if (!active) pasteUi.current?.close();
  }, [active]);

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
    // Opening the vault makes an initially unreadable share eligible again.
    // Do not tear down the socket or require a tab/page reload to pick it up.
    const newlyUnlocked = vault.status === "unlocked" && lastVaultStatus.current !== "unlocked";
    lastVaultStatus.current = vault.status;
    if (newlyUnlocked && share && isVaultShare(share.sealed)) {
      tried.current.delete(`${share.senderPublicKey}:${share.sealed}`);
    }
    if (status !== "needs-password" || !share || !id || attempt.current) return;
    if (isVaultShare(share.sealed) && vault.status !== "unlocked") return;
    const key = `${share.senderPublicKey}:${share.sealed}`;
    if (tried.current.has(key)) return;
    const target = connection.current;
    if (!target) return;
    let cancelled = false;
    let submitted = false;
    const attempts = tried.current;
    tried.current.add(key);
    void vaultRef.current.openShare(id, share).then((password) => {
      if (cancelled || !password || connection.current !== target || attempt.current) return;
      if (isVaultShare(share.sealed) && vaultRef.current.status !== "unlocked") return;
      pending.current = [];
      submitted = true;
      attempt.current = { source: isVaultShare(share.sealed) ? "vault" : "legacy", password };
      void target.submitPassword(password);
    });
    return () => {
      cancelled = true;
      if (!submitted) attempts.delete(key);
    };
  }, [sealed, status, shareUrl, renderer, vault.status]);

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

  async function handleAsk() {
    if (!onRequestPassword) return;
    setAsking(true);
    setAskError("");
    try {
      await onRequestPassword();
    } catch (caught) {
      setAskError(caught instanceof Error ? caught.message : "Could not send the request. Try again.");
    } finally {
      setAsking(false);
    }
  }

  const locked = status === "needs-password";
  const owner = ownerName || "the owner";
  const sessionOver = status === "ended" || status === "missing" || status === "error";
  const machineAway = !locked && !sessionOver && hostIsAway(hostState?.presence);
  const notice = machineAway
    ? hostNotice({
        status: hostState?.presence,
        hostLastSeenAt: hostState?.lastSeenAt,
        screenCapturedAt: hostState?.screenCapturedAt,
        hasScreen,
        now,
      })
    : null;

  return (
    <div className="pane" data-active={active} data-renderer={renderer} aria-hidden={!active}>
      <div className="pane-tools">
        {pulseAllowed && pulse && <SessionPulseBadge pulse={pulse} />}
        {mcpAuthorized && <span className="pane-mcp-disclosure" role="status"
          title="The host authorizes the server to decrypt terminal frames and send plaintext to MCP agents for the grant lifetime.">
          MCP · server-side decryption authorized
        </span>}
        <div ref={toolsMount} className="refstream-toolbar pane-refstream-toolbar" aria-label="Refstream terminal tools" />
        <div ref={filesMount} className="pane-files-toolbar" aria-label="Shared files" />
        <div ref={pasteMount} className="pane-paste-toolbar" />
      </div>
      <div className="pane-screen" ref={mount} />

      {locked && (
        <div className="pane-gate">
          <div className="pane-gate-card">
            {vault.status === "locked" && (
              <>
                <p>Open this session with your vault or its password.</p>
                <div className="pane-access-options" role="group" aria-label="Session unlock method">
                  <Button type="button" variant={unlockMethod !== "password" ? "primary" : "ghost"} onClick={() => setUnlockMethod("vault")}>Unlock vault</Button>
                  <Button type="button" variant={unlockMethod === "password" ? "primary" : "ghost"} onClick={() => setUnlockMethod("password")}>Session password</Button>
                </div>
              </>
            )}
            {vault.status === "locked" && unlockMethod !== "password" ? (
              <VaultUnlock compact allowReset={false} />
            ) : (
              <form className="pane-password-form" onSubmit={handleUnlock}>
                <span className="pane-gate-mark" aria-hidden="true">
                  <LockKey size={20} />
                </span>
                <h2>Enter the session password</h2>
                <p>
                  Use this session’s password, not your account password. It opens
                  the terminal on this device. An unlocked vault can save it for next time.
                </p>
                {vault.status === "error" && <p>Your vault could not be reached. <button type="button" className="vault-link" onClick={vault.retry}>Try the vault again</button>, or enter the session password below.</p>}
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
                {/* The password never goes with it; whether a saved one failed does. */}
                <FeedbackLink
                  surface="session-gate"
                  kind="problem"
                  context={{ host, saved_password_failed: detail ? "yes" : undefined }}
                >
                  Stuck here? Tell us
                </FeedbackLink>
              </form>
            )}
            {/*
              * No password to type? Ask for it here, where the need is, under
              * either way of unlocking. The owner sees the count on their Share
              * button and answers in one click; accepting seals the password to
              * this person's vault, and the next poll brings the copy that
              * opens this pane by itself.
              */}
            {onRequestPassword && (
              <div className="pane-gate-ask" role="status">
                {passwordRequest?.status === "pending" ? (
                  <p>
                    <HourglassMedium size={15} />
                    <span>
                      Asked {owner} for the password. This opens by itself when they accept.
                    </span>
                  </p>
                ) : passwordRequest?.status === "approved" ? (
                  <p>
                    <CheckCircle size={15} />
                    <span>
                      {owner} shared the password with you. If this does not open in a moment,
                      unlock your vault.
                    </span>
                  </p>
                ) : (
                  <>
                    {passwordRequest?.status === "declined" && (
                      <p>
                        <span>{owner} declined your request.</span>
                      </p>
                    )}
                    <Button type="button" variant="ghost" busy={asking} busyLabel="Asking" onClick={() => void handleAsk()}>
                      <Key size={15} weight="bold" />
                      {passwordRequest?.status === "declined" ? "Ask again" : `Ask ${owner} for the password`}
                    </Button>
                  </>
                )}
                {askError && <Alert tone="error">{askError}</Alert>}
              </div>
            )}
          </div>
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
            <FeedbackLink surface="session-ended" context={{ status, detail: detail || undefined }}>
              Not what you expected? Tell us
            </FeedbackLink>
          </div>
        </div>
      )}

      {!canType && status === "connected" && (
        <div className="pane-banner pane-watching">Watching. Only the owner and assignees can type.</div>
      )}

      {/*
        * The machine, not this viewer. Shown over a kept screen as a strip, and
        * in the middle of the pane when there is no screen to keep, so an empty
        * terminal is never left to speak for itself.
        */}
      {notice && (
        <div className={notice.showingKeptScreen ? "pane-offline over-screen" : "pane-offline"} role="status">
          <strong>{notice.heading}</strong>
          <span>{notice.body}</span>
        </div>
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
