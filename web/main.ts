import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./vendor/refstream/v0.1.0-alpha.5/refstream.css";
import "./vendor/refstream/v0.1.0-alpha.5/ui.css";
import {
  decodeLatencyProbe,
  encodeFrame,
  encodeLatencyProbe,
  isSnapshotOpcode,
  Opcode,
} from "../shared/protocol";
import { readOnlyFromControlMessage } from "../shared/session-access";
import { hostIsAway, hostNotice } from "../shared/host-presence";
import {
  isSessionFullClose,
  MAX_SESSION_VIEWERS,
} from "../shared/session-capacity";
import { RELEASE_CHECKSUMS_PATH, RELEASE_VERSION } from "../shared/release";
import {
} from "../shared/github";
import { TerminalWriteQueue } from "./terminal-writes";
import {
  createTerminal,
  readTerminalRenderer,
  writeTerminalRenderer,
  type TerminalRenderer,
} from "./terminal-renderer";
import { attachRefstreamTools } from "./refstream-tools";
import { mountTerminalPaste } from "./terminal-paste";
import "./terminal-paste.css";
import { purgeLegacyRefstreamSessionCaches } from "./refstream-session";
import { RelayFileClient } from "./relay-files";
import { mountRelayFileBrowser } from "./relay-files-ui";
import { TerminalInputQueue } from "./terminal-input";
import { mobileTerminalKeyBytes, terminalKeyAction } from "./terminal-keyboard";
import { DestructiveInputGuard } from "./destructive-input";
import { BrowserFrameCipher, E2EEReplayError, parseEncryptionFragment } from "../shared/e2ee";
import {
  renderDocumentation,
  resolveCurrentDocumentationRoute,
} from "./documentation";
import {
  appendLatencySample,
  buildLatencyPlot,
  parseLatencyHistory,
  summarizeLatency,
  type LatencySample,
} from "./latency-history";
import { MobileViewportTracker, terminalTypography } from "./mobile-viewport";
import { fittedTerminal } from "./terminal-fit";
import { cellMeasurer, terminalBox } from "./terminal-metrics";
import {
  DESKTOP_TERMINAL_GRID,
  isValidTerminalGrid,
} from "../shared/terminal-grid";
import { mcpDisclosure } from "../shared/mcp-disclosure";
import { renderStatsDashboard } from "./stats";
import {
  TerminalLineScroller,
  TerminalPinchZoomGesture,
  TerminalTouchScrollBridge,
  type TouchSample,
} from "./touch-scroll";
import "./style.css";
import "./relay-files.css";
import "./landing.css";
import "./session-theme.css";
import { initAnalytics } from "./analytics";
import { sessionConnectionLabel } from "./session-status";
import { beginProductOperation, observeProductPage, trackProduct } from "./posthog";
import { terminalCloseOutcome } from "../shared/analytics-operations";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing app root");

initAnalytics();
observeProductPage();
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("#issue-open")) trackProduct("report_opened", { target: "feedback" });
});

type TerminalColorMode = "dark" | "light";
const TYPING_LEASE_MS = 1_800;
interface PresenceParticipant {
  id: number;
  name: string;
  color: number;
  typingAt?: number;
}

const terminalThemes: Record<TerminalColorMode, ITheme> = {
  dark: {
    background: "#161914",
    foreground: "#eef1f6",
    cursor: "#dce6ff",
    cursorAccent: "#161914",
    selectionBackground: "#496cae99",
    selectionInactiveBackground: "#36466588",
    black: "#586174",
    red: "#ff6f78",
    green: "#78dba9",
    yellow: "#e9cb77",
    blue: "#82aaff",
    magenta: "#c79bf0",
    cyan: "#6ed8dd",
    white: "#d9dee8",
    brightBlack: "#858fa3",
    brightRed: "#ff9299",
    brightGreen: "#98e5bf",
    brightYellow: "#f2db99",
    brightBlue: "#a5c0ff",
    brightMagenta: "#ddb9fa",
    brightCyan: "#94e7eb",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#f3f1e9",
    foreground: "#202633",
    cursor: "#25304a",
    cursorAccent: "#f3f1e9",
    selectionBackground: "#7196d34d",
    selectionInactiveBackground: "#8da0be38",
    black: "#303846",
    red: "#b93649",
    green: "#237451",
    yellow: "#806000",
    blue: "#315fa8",
    magenta: "#7d479d",
    cyan: "#176d76",
    white: "#d9dde5",
    brightBlack: "#626c7d",
    brightRed: "#d24b5c",
    brightGreen: "#2e8b62",
    brightYellow: "#987300",
    brightBlue: "#4676c2",
    brightMagenta: "#985caf",
    brightCyan: "#23838d",
    brightWhite: "#ffffff",
  },
};

purgeLegacyRefstreamSessionCaches();

const sessionMatch = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]{32})\/?$/);
const documentationRoute = resolveCurrentDocumentationRoute(window.location.pathname);
const statsDashboard = window.location.hostname === "stats.shell.online" ||
  ((window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
    window.location.pathname === "/stats");

if (statsDashboard) {
  renderStatsDashboard(app);
} else if (sessionMatch) {
  renderTerminal(sessionMatch[1]);
} else if (window.location.pathname === "/" || window.location.pathname === "") {
  renderLanding();
} else if (documentationRoute) {
  void renderDocumentation(app, documentationRoute, renderNotFound);
} else {
  renderNotFound();
}

function renderLanding(): void {
  void import("./landing").then(({ initLanding }) => initLanding());
}

type CopyTarget = "install" | "brew_install" | "source_build" | "run" | "share" | "skill";
type CtaTarget = "signup_nav" | "signup_hero" | "signup_team" | "signup_footer";

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

function trackCopy(target: CopyTarget): void {
  trackEvent("copy", target);
}

function trackEvent(event: "copy" | "cta_click", target: CopyTarget | CtaTarget): void {
  trackProduct(event === "copy" ? "command_copy" : "landing_cta", { target });
  void fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, target }),
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => {
    // Copying and navigating should still succeed if analytics is unavailable.
  });
}

function renderTerminal(sessionId: string): void {
  document.title = "Shared terminal — shell.online";
  const encryptionDescriptor = parseEncryptionFragment(window.location.hash);
  const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
  let followsSystemTheme = true;
  let colorMode: TerminalColorMode = systemTheme.matches ? "light" : "dark";
  let terminalZoomPercent = 100;
  const terminalRenderer = readTerminalRenderer();
  let showRefstreamNotice = false;
  try {
    const stored = localStorage.getItem("shell-online-terminal-theme");
    if (stored === "dark" || stored === "light") {
      colorMode = stored;
      followsSystemTheme = false;
    }
    const storedZoom = Number(localStorage.getItem("shell-online-terminal-zoom"));
    if (Number.isFinite(storedZoom) && storedZoom >= 50 && storedZoom <= 150) {
      terminalZoomPercent = Math.round(storedZoom / 5) * 5;
    }
    if (terminalRenderer === "refstream" && sessionStorage.getItem("shell-online-refstream-notice") === "1") {
      showRefstreamNotice = true;
      sessionStorage.removeItem("shell-online-refstream-notice");
    }
  } catch {
    // Storage may be disabled; system theme and default zoom still work.
  }
  app!.innerHTML = `
    <section class="session-page theme-${colorMode}">
      <header id="session-header" class="session-header">
        <a class="wordmark compact" href="/" target="_blank" rel="noreferrer"><span>shell</span><i>.</i>online</a>
        <div class="session-identity">
          <span id="session-label">Shared terminal</span>
          <span id="session-access" class="session-access" hidden>View only</span>
          <span id="session-encryption" class="session-access encryption" hidden>End-to-end encrypted</span>
          <span id="session-status" class="status offline" role="status" aria-live="polite"><i></i><b>Offline</b></span>
          <span id="typing-status" class="typing-status" hidden></span>
        </div>
        <div class="session-actions">
          <div id="presence" class="presence" aria-label="No collaborators connected"></div>
          <div id="relay-files-tools" class="relay-files-tools"></div>
          <button id="theme-toggle" class="theme-button" type="button">
            <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.25"></circle>
              <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.28 5.28l1.42 1.42M17.3 17.3l1.42 1.42M18.72 5.28 17.3 6.7M6.7 17.3l-1.42 1.42"></path>
            </svg>
            <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19.1 15.3A7.7 7.7 0 0 1 8.7 4.9 7.7 7.7 0 1 0 19.1 15.3Z"></path>
            </svg>
          </button>
          <a id="issue-open" class="settings-button" href="https://app.shell.online/feedback?from=terminal" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="Report an issue in the app (opens a new tab)" title="Report an issue in the app (opens a new tab)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4.5"></path><path d="M12 15.5h.01"></path></svg>
            <span>Report</span>
          </a>
          <button id="settings-open" class="settings-button" type="button" aria-label="Open terminal controls" title="Terminal controls" aria-haspopup="dialog" aria-controls="terminal-settings">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"></path>
            </svg>
            <span>Controls</span>
          </button>
        </div>
      </header>
      <div id="terminal-wrap" class="terminal-wrap">
        <div id="refstream-toolbar" class="refstream-toolbar" aria-label="Refstream terminal tools"></div>
        <div id="terminal" class="terminal" aria-label="Shared interactive terminal"></div>
        <div id="session-offline" class="session-offline" role="status" aria-live="polite" hidden></div>
        ${showRefstreamNotice ? '<div id="refstream-alpha-notice" class="refstream-alpha-notice" role="status">Refstream is an experimental alpha renderer and may still be unstable.</div>' : ""}
        <div id="terminal-input-warning" class="terminal-input-warning" role="status" aria-live="assertive" hidden></div>
      </div>
      <nav id="mobile-terminal-keys" class="mobile-terminal-keys" aria-label="Terminal navigation keys">
        <span id="terminal-paste-toolbar"></span>
        <button type="button" data-terminal-key="escape" aria-label="Escape">esc</button>
        <button type="button" data-terminal-key="tab" aria-label="Tab">tab</button>
        <button type="button" data-terminal-key="left" aria-label="Left arrow">←</button>
        <button type="button" data-terminal-key="up" aria-label="Up arrow">↑</button>
        <button type="button" data-terminal-key="down" aria-label="Down arrow">↓</button>
        <button type="button" data-terminal-key="right" aria-label="Right arrow">→</button>
        <button type="button" data-terminal-key="enter" aria-label="Enter">enter</button>
        <button type="button" data-terminal-key="interrupt" aria-label="Control C">ctrl-c</button>
      </nav>
      <div id="encryption-gate" class="encryption-gate" hidden>
        <form id="encryption-form" class="encryption-panel">
          <span class="settings-kicker">Private terminal</span>
          <h2>Enter the session password</h2>
          <p id="encryption-message">Use the password printed next to the link on the host computer, or ask the person who shared it.</p>
          <label for="encryption-password">Password</label>
          <input id="encryption-password" type="password" required autocomplete="current-password" autocapitalize="off" spellcheck="false" aria-describedby="encryption-message encryption-privacy" />
          <button type="submit">Open terminal</button>
          <p id="encryption-privacy" class="encryption-help">This is the session password, not your account password. It unlocks the terminal on this device and is never sent to shell.online.</p>
          <details class="encryption-help"><summary>Need the password?</summary><p>On the computer running this session, use <code>shell list</code> to find its ID, then <code>shell password &lt;ID&gt;</code>. If it is saved in your vault, <a href="https://app.shell.online/sessions" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">open the app</a> and unlock your vault there.</p></details>
        </form>
      </div>
      <dialog id="terminal-settings" class="settings-dialog" aria-labelledby="settings-title">
        <div class="settings-panel">
          <header class="settings-header">
            <div>
              <span class="settings-kicker">Terminal</span>
              <h2 id="settings-title">Controls</h2>
            </div>
            <button id="settings-close" class="settings-close" type="button" aria-label="Close terminal controls">×</button>
          </header>
          <div class="settings-content">
            <div class="settings-control-grid">
              <section class="settings-card zoom-card" aria-labelledby="zoom-label">
                <div class="settings-card-heading">
                  <span id="zoom-label">Zoom</span>
                  <output id="zoom-value" for="terminal-zoom">100%</output>
                </div>
                <input id="terminal-zoom" type="range" min="50" max="150" step="5" value="100" aria-labelledby="zoom-label" />
                <div class="zoom-ends"><span>More space</span><span>Larger text</span></div>
              </section>
              <section class="settings-card appearance-card" aria-labelledby="appearance-label">
                <div class="settings-card-heading"><span id="appearance-label">Appearance</span></div>
                <div id="theme-options" class="theme-options" role="group" aria-labelledby="appearance-label">
                  <button type="button" data-theme="system">System</button>
                  <button type="button" data-theme="light">Light</button>
                  <button type="button" data-theme="dark">Dark</button>
                </div>
              </section>
              <section class="settings-card renderer-card" aria-labelledby="renderer-label">
                <div class="settings-card-heading"><label id="renderer-label" for="terminal-renderer">Renderer</label></div>
                <select id="terminal-renderer" aria-describedby="renderer-description">
                  <option value="xterm">xterm.js</option>
                  <option value="refstream">Refstream (unstable alpha)</option>
                </select>
                <span id="renderer-description">Refstream is experimental and may be unstable. Changing renderer reopens this view.</span>
              </section>
            </div>
            <section class="settings-account-card" aria-labelledby="settings-account-title">
              <div><h3 id="settings-account-title">Keep your sessions in one place</h3>
              <p>Create an account and link your computer to find your active sessions in the app.</p></div>
              <a id="settings-signup" href="https://app.shell.online/signup" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Sign up</a>
            </section>
            <section class="latency-card" aria-labelledby="latency-title">
              <div class="latency-heading">
                <div>
                  <span class="settings-kicker">Browser → machine</span>
                  <h3 id="latency-title">Latency</h3>
                </div>
                <strong id="latency-current">—</strong>
              </div>
              <svg id="latency-graph" class="latency-graph" viewBox="0 0 320 92" preserveAspectRatio="none" role="img" aria-label="No latency samples yet">
                <defs>
                  <linearGradient id="latency-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="currentColor" stop-opacity="0.3"></stop>
                    <stop offset="1" stop-color="currentColor" stop-opacity="0"></stop>
                  </linearGradient>
                </defs>
                <path class="latency-grid" d="M0 23H320M0 46H320M0 69H320"></path>
                <path id="latency-area" class="latency-area"></path>
                <path id="latency-line" class="latency-line"></path>
                <circle id="latency-point" class="latency-point" r="3" hidden></circle>
              </svg>
              <div class="latency-stats">
                <span>Min <b id="latency-min">—</b></span>
                <span>Avg <b id="latency-average">—</b></span>
                <span>Max <b id="latency-max">—</b></span>
                <span id="latency-window">Cached locally</span>
              </div>
            </section>
          </div>
          <footer class="settings-footer">
            <button id="settings-copy-link" class="settings-copy" type="button">Copy sharing link</button>
            <div>
              <span id="session-access-description">Anyone with the link can view and type.</span>
              <a href="${RELEASE_CHECKSUMS_PATH}" target="_blank" rel="noreferrer">v${RELEASE_VERSION} · SHA-256 checksums</a>
            </div>
          </footer>
        </div>
      </dialog>
    </section>
  `;

  const terminalElement = requiredElement("terminal");
  const terminalWrap = requiredElement("terminal-wrap");
  const refstreamToolbar = requiredElement("refstream-toolbar");
  const terminalInputWarning = requiredElement("terminal-input-warning");
  const offlineNotice = requiredElement("session-offline");
  const mobileKeyButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#mobile-terminal-keys [data-terminal-key]"),
  );
  const sessionHeader = requiredElement("session-header");
  const sessionPage = document.querySelector<HTMLElement>(".session-page");
  if (!sessionPage) throw new Error("Missing session page");
  const statusElement = requiredElement("session-status");
  const statusText = statusElement.querySelector("b");
  const identityElement = document.querySelector<HTMLElement>(".session-identity");
  if (!identityElement) throw new Error("Missing session identity");
  const labelElement = requiredElement("session-label");
  const accessBadge = requiredElement("session-access");
  const encryptionBadge = requiredElement("session-encryption");
  const accessDescription = requiredElement("session-access-description");
  const typingElement = requiredElement("typing-status");
  const presenceElement = requiredElement("presence");
  const copyButton = requiredElement<HTMLButtonElement>("settings-copy-link");
  const settingsButton = requiredElement<HTMLButtonElement>("settings-open");
  const settingsDialog = requiredElement<HTMLDialogElement>("terminal-settings");
  const relayFilesTools = requiredElement("relay-files-tools");
  const encryptionGate = requiredElement("encryption-gate");
  const encryptionForm = requiredElement<HTMLFormElement>("encryption-form");
  const encryptionPassword = requiredElement<HTMLInputElement>("encryption-password");
  const encryptionMessage = requiredElement("encryption-message");
  const settingsCloseButton = requiredElement<HTMLButtonElement>("settings-close");
  const themeButton = requiredElement<HTMLButtonElement>("theme-toggle");
  const zoomInput = requiredElement<HTMLInputElement>("terminal-zoom");
  const zoomValue = requiredElement<HTMLOutputElement>("zoom-value");
  const rendererSelect = requiredElement<HTMLSelectElement>("terminal-renderer");
  const themeOptionButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#theme-options [data-theme]"),
  );
  const latencyCurrent = requiredElement("latency-current");
  const latencyMinimum = requiredElement("latency-min");
  const latencyAverage = requiredElement("latency-average");
  const latencyMaximum = requiredElement("latency-max");
  const latencyWindow = requiredElement("latency-window");
  const latencyGraph = document.querySelector<SVGSVGElement>("#latency-graph");
  const latencyLine = document.querySelector<SVGPathElement>("#latency-line");
  const latencyArea = document.querySelector<SVGPathElement>("#latency-area");
  const latencyPoint = document.querySelector<SVGCircleElement>("#latency-point");
  if (!latencyGraph || !latencyLine || !latencyArea || !latencyPoint) {
    throw new Error("Missing latency graph");
  }
  const compactSessionQuery = window.matchMedia("(max-width: 760px), (pointer: coarse)");
  const compactPresenceQuery = window.matchMedia("(max-width: 480px)");

  rendererSelect.value = terminalRenderer;
  rendererSelect.addEventListener("change", () => {
    const next: TerminalRenderer = rendererSelect.value === "refstream" ? "refstream" : "xterm";
    if (next === terminalRenderer) return;
    trackProduct("feature_action", { operation: "terminal_renderer" });
    writeTerminalRenderer(next);
    if (next === "refstream") {
      try {
        sessionStorage.setItem("shell-online-refstream-notice", "1");
      } catch {
        // The option label still identifies Refstream as an unstable alpha.
      }
    }
    window.location.reload();
  });

  const refstreamNotice = document.querySelector<HTMLElement>("#refstream-alpha-notice");
  if (refstreamNotice) {
    window.setTimeout(() => refstreamNotice.remove(), 6_000);
  }

  const terminal = createTerminal(terminalRenderer, {
    cursorBlink: !compactSessionQuery.matches,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    fontWeight: "400",
    fontWeightBold: "700",
    lineHeight: 1.18,
    letterSpacing: 0,
    scrollback: compactSessionQuery.matches ? 3_000 : 10_000,
    drawBoldTextInBrightColors: true,
    macOptionIsMeta: true,
    scrollOnUserInput: true,
    theme: terminalThemes[colorMode],
  }, {
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: true,
    allowTransparency: false,
  });
  const measureCell = cellMeasurer(terminal.options.fontFamily ?? "monospace");
  terminal.open(terminalElement);
  const helperTextarea = terminalElement.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea, .shell-terminal-input",
  );
  if (helperTextarea) {
    helperTextarea.autocapitalize = "off";
    helperTextarea.autocomplete = "off";
    helperTextarea.setAttribute("autocorrect", "off");
    helperTextarea.spellcheck = false;
    helperTextarea.enterKeyHint = "enter";
  }
  const textEncoder = new TextEncoder();
  const terminalWrites = new TerminalWriteQueue(
    terminal,
    compactSessionQuery.matches ? 16 * 1024 : 32 * 1024,
    768 * 1024,
  );

  let socket: WebSocket | null = null;
  let stopped = false;
  let terminalColumns = DESKTOP_TERMINAL_GRID.cols;
  let terminalRows = DESKTOP_TERMINAL_GRID.rows;
  let retryAttempt = 0;
  let retryTimer: number | undefined;
  let lastStatus = "waiting";
  let resizeFrame: number | undefined;
  let viewportSampleFrame: number | undefined;
  let viewportSampleUntil = 0;
  let lastViewportWidth = 0;
  let lastViewportHeight = 0;
  let lastKeyboardOpen = false;
  let lastViewerPortrait: boolean | undefined;
  const mobileViewport = new MobileViewportTracker();
  let copyAttempt = 0;
  let copyResetTimer: number | undefined;
  let latencyTimer: number | undefined;
  let latencyTimeout: number | undefined;
  let pendingLatencyToken: number | undefined;
  let pendingLatencyStarted = 0;
  let latencyMilliseconds: number | null = null;
  const latencyStorageKey = `shell-online-latency:${sessionId}`;
  let latencySamples: LatencySample[] = [];
  let selfViewerId: number | null = null;
  let participants: PresenceParticipant[] = [];
  let localTypingAt: number | undefined;
  let activeAgents: string[] = [];
  // The server's actual MCP decryption capability (from the presence broadcast), distinct from the
  // activity chips: the trust-boundary disclosure tracks whether the server can decrypt frames for
  // an MCP agent, not whether a presence chip is currently shown.
  let mcpDecrypt = false;
  let presenceTimer: number | undefined;
  let readOnly = false;
  let snapshotRequestPending = false;
  let terminalSnapshotGeneration = 0;
  let rendererInputSuppressed = false;
  const terminalInput = new TerminalInputQueue(() => socket);
  const destructiveInput = new DestructiveInputGuard();
  let destructiveInputTimer: number | undefined;
  let frameCipher: BrowserFrameCipher | null = null;
  // The URL fragment is the viewer's cryptographic intent. Never let an
  // untrusted relay downgrade a link that already carries E2EE material.
  let encryptedSession = encryptionDescriptor !== null;
  let persistentSession = false;
  let waitingForEncryptionKey = false;
  let waitingForCapacity = false;
  let outgoingFrames = Promise.resolve();
  let incomingFrames = Promise.resolve();
  /*
   * The machine's own state, which is not this viewer's connection state. A
   * viewer can be perfectly connected to a session whose machine has closed
   * its lid, and until this was shown that read as a terminal that simply
   * failed to appear.
   */
  let hostStatus: string | undefined;
  let hostLastSeenAt: string | undefined;
  let screenCapturedAt: string | undefined;
  let hasTerminalContent = false;
  let offlineNoticeTimer: number | undefined;

  const syncMobileKeys = (): void => {
    const disabled = stopped || readOnly || waitingForEncryptionKey ||
      lastStatus !== "connected" || socket?.readyState !== WebSocket.OPEN ||
      terminalElement.classList.contains("input-locked");
    for (const button of mobileKeyButtons) button.disabled = disabled;
  };

  syncMobileKeys();

  terminalInput.setEncoder((chunk) => {
    const frame = encodeFrame(Opcode.Input, chunk);
    return frameCipher ? frameCipher.seal(frame) : frame;
  });

  const sendBinaryFrame = (frame: Uint8Array): void => {
    outgoingFrames = outgoingFrames.then(async () => {
      const current = socket;
      if (current?.readyState !== WebSocket.OPEN) return;
      current.send(frameCipher ? await frameCipher.seal(frame) : new Uint8Array(frame));
    }).catch(() => undefined);
  };

  const fileClient = new RelayFileClient(sendBinaryFrame);
  if (terminalRenderer === "refstream") terminal.options.fileLinks = fileClient.fileLinks;
  const fileBrowser = mountRelayFileBrowser(fileClient, relayFilesTools, terminalWrap);

  const showEncryptionGate = (message: string, allowPassword: boolean): void => {
    waitingForEncryptionKey = true;
    encryptionGate.hidden = false;
    encryptionMessage.textContent = message;
    encryptionPassword.hidden = !allowPassword;
    encryptionForm.querySelector<HTMLLabelElement>("label")!.hidden = !allowPassword;
    encryptionForm.querySelector<HTMLButtonElement>("button")!.hidden = !allowPassword;
    terminal.options.disableStdin = true;
    statusText!.textContent = allowPassword ? "Password needed" : "Access blocked";
    statusElement.setAttribute("aria-label", statusText!.textContent);
    syncMobileKeys();
    if (allowPassword) encryptionPassword.focus();
  };

  const defaultCopyLabel = (): string =>
    readOnly ? "Copy read-only link" : "Copy sharing link";

  const renderAccessDescription = (): void => {
    const credential = encryptedSession ? "link and password" : "link";
    accessDescription.textContent = readOnly
      ? `This ${credential} is view only. Browser input is blocked.`
      : `Anyone with the ${credential} can view and type.`;
  };

  // Re-derive the badge label + trust-boundary title from current session state. The MCP
  // disclosure is state-dependent: it only claims server-side decryption while an MCP grant is
  // authorized (tracked independently of recent activity) and reverts to the plain E2EE/TLS
  // disclosure otherwise, so the badge never overstates the control channel's reach.
  const updateEncryptionDisclosure = (): void => {
    if (encryptionBadge.hidden) return;
    // Base the trust-boundary disclosure on the server's actual decryption capability (broadcast),
    // not the presence chips: the E2EE badge only claims server-side MCP decryption while a
    // grant is live, and reverts to the plain E2EE/TLS disclosure otherwise.
    const disclosure = mcpDisclosure(encryptedSession, mcpDecrypt, persistentSession);
    encryptionBadge.textContent = disclosure.label;
    encryptionBadge.title = disclosure.title;
    encryptionBadge.setAttribute("aria-label", disclosure.label);
    encryptionBadge.dataset.compactLabel = disclosure.label;
  };

  const applyEncryptionMode = (encrypted: boolean): void => {
    encryptedSession = encrypted;
    encryptionBadge.hidden = false;
    encryptionBadge.classList.toggle("unencrypted", !encrypted);
    updateEncryptionDisclosure();
    renderAccessDescription();
    if (encrypted && !frameCipher && !encryptionDescriptor) {
      showEncryptionGate("This link is incomplete. Ask the sender to copy the whole link, including everything after #. A password alone cannot open it.", false);
      socket?.close(4003, "missing encryption key");
    }
  };

  const applyReadOnly = (nextReadOnly: boolean): void => {
    readOnly = nextReadOnly;
    sessionPage.classList.toggle("read-only", readOnly);
    accessBadge.hidden = !readOnly;
    renderAccessDescription();
    terminalElement.setAttribute("aria-label", readOnly
      ? "Shared read-only terminal"
      : "Shared interactive terminal");
    terminalElement.setAttribute("aria-readonly", String(readOnly));
    terminal.options.disableStdin = stopped || readOnly || terminalElement.classList.contains("input-locked");
    syncMobileKeys();
    if (copyButton.dataset.state === undefined) copyButton.textContent = defaultCopyLabel();
    if (readOnly) {
      terminal.blur();
      helperTextarea?.blur();
    }
  };

  try {
    latencySamples = parseLatencyHistory(localStorage.getItem(latencyStorageKey));
  } catch {
    // The live graph still works when local storage is unavailable.
  }

  const formatLatency = (value: number | null): string =>
    value === null ? "—" : `${value} ms`;

  const renderLatencyGraph = (): void => {
    const plot = buildLatencyPlot(latencySamples);
    const summary = summarizeLatency(latencySamples);
    latencyLine.setAttribute("d", plot.linePath);
    latencyArea.setAttribute("d", plot.areaPath);
    latencyPoint.toggleAttribute("hidden", plot.linePath.length === 0);
    latencyPoint.setAttribute("cx", plot.lastX.toFixed(2));
    latencyPoint.setAttribute("cy", plot.lastY.toFixed(2));
    const online = lastStatus === "connected" && latencyMilliseconds !== null;
    latencyCurrent.textContent = online ? `${latencyMilliseconds} ms` : "Offline";
    latencyCurrent.classList.toggle("offline", !online);
    latencyMinimum.textContent = formatLatency(summary.minimum);
    latencyAverage.textContent = formatLatency(summary.average);
    latencyMaximum.textContent = formatLatency(summary.maximum);
    latencyWindow.textContent = latencySamples.length === 0
      ? "Waiting for samples"
      : `${latencySamples.length} sample${latencySamples.length === 1 ? "" : "s"} · cached locally`;
    latencyGraph.setAttribute(
      "aria-label",
      latencySamples.length === 0
        ? "No latency samples yet"
        : `Live latency graph. Current ${online ? `${latencyMilliseconds} milliseconds` : "offline"}. ` +
          `Minimum ${summary.minimum}, average ${summary.average}, maximum ${summary.maximum} milliseconds.`,
    );
  };

  const recordLatencySample = (milliseconds: number): void => {
    latencySamples = appendLatencySample(latencySamples, {
      at: Date.now(),
      ms: milliseconds,
    });
    try {
      localStorage.setItem(latencyStorageKey, JSON.stringify(latencySamples));
    } catch {
      // Rendering does not depend on persistence.
    }
    renderLatencyGraph();
  };

  const applyColorMode = (nextMode: TerminalColorMode, persist: boolean): void => {
    colorMode = nextMode;
    if (persist) {
      followsSystemTheme = false;
      try {
        localStorage.setItem("shell-online-terminal-theme", colorMode);
      } catch {
        // Theme switching does not depend on storage.
      }
    }
    sessionPage.classList.toggle("theme-dark", colorMode === "dark");
    sessionPage.classList.toggle("theme-light", colorMode === "light");
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", colorMode === "dark" ? "#161914" : "#f3f1e9");
    terminal.options.theme = terminalThemes[colorMode];
    themeButton.classList.toggle("shows-sun", colorMode === "dark");
    themeButton.classList.toggle("shows-moon", colorMode === "light");
    themeButton.setAttribute("aria-label", `Switch to ${colorMode === "dark" ? "light" : "dark"} terminal`);
    themeButton.title = `Switch to ${colorMode === "dark" ? "light" : "dark"} terminal`;
    for (const button of themeOptionButtons) {
      const preference = button.dataset.theme;
      const selected = followsSystemTheme ? preference === "system" : preference === colorMode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  };

  applyColorMode(colorMode, false);
  zoomInput.value = String(terminalZoomPercent);
  zoomValue.value = `${terminalZoomPercent}%`;
  renderLatencyGraph();

  const renderPresence = (): void => {
    window.clearTimeout(presenceTimer);
    const now = Date.now();
    const typingParticipants = participants.filter(
      (participant) =>
        participant.id !== selfViewerId &&
        participant.typingAt !== undefined &&
        now - participant.typingAt < TYPING_LEASE_MS,
    );
    const localOwnerIsTyping =
      localTypingAt !== undefined && now - localTypingAt < TYPING_LEASE_MS;

    if (localOwnerIsTyping) {
      typingElement.textContent = "Local owner is typing…";
    } else if (typingParticipants.length === 1) {
      typingElement.textContent = `${typingParticipants[0].name} is typing…`;
    } else if (typingParticipants.length > 1) {
      typingElement.textContent = `${typingParticipants.length} people are typing…`;
    } else {
      typingElement.textContent = "";
    }
    const inputIsLocked = localOwnerIsTyping || typingParticipants.length > 0;
    const wasInputLocked = terminalElement.classList.contains("input-locked");
    if (inputIsLocked && !wasInputLocked) terminalInput.clear();
    typingElement.hidden = !inputIsLocked;
    identityElement.classList.toggle("has-typing", inputIsLocked);
    terminalElement.classList.toggle("input-locked", inputIsLocked);
    terminal.options.disableStdin = stopped || readOnly || inputIsLocked;
    syncMobileKeys();

    presenceElement.replaceChildren();
    const visibleCount = compactPresenceQuery.matches ? 1 : 4;
    for (const participant of participants.slice(0, visibleCount)) {
      const avatar = document.createElement("span");
      const isSelf = participant.id === selfViewerId;
      const isTyping = typingParticipants.some((candidate) => candidate.id === participant.id);
      const guestNumber = participant.name.match(/\d+$/)?.[0] ?? "•";
      avatar.className = `presence-avatar color-${participant.color}`;
      avatar.classList.toggle("self", isSelf);
      avatar.classList.toggle("typing", isTyping);
      avatar.textContent = guestNumber;
      avatar.title = `${participant.name}${isSelf ? " (you)" : isTyping ? " — typing" : ""}`;
      avatar.setAttribute("aria-label", avatar.title);
      presenceElement.append(avatar);
    }

    if (participants.length > visibleCount) {
      const overflow = document.createElement("span");
      overflow.className = "presence-avatar presence-more";
      overflow.textContent = `+${participants.length - visibleCount}`;
      overflow.title = `${participants.length - visibleCount} more collaborators`;
      overflow.setAttribute("aria-label", overflow.title);
      presenceElement.append(overflow);
    }

    // MCP presence: conspicuous `Agent: <label>` chips for active controller grants. Separate from
    // the viewer avatars and never changes the terminal grid.
    for (const label of activeAgents) {
      const chip = document.createElement("span");
      chip.className = "presence-agent";
      chip.textContent = `Agent: ${label}`;
      chip.title = `Controller agent: ${label}`;
      chip.setAttribute("aria-label", chip.title);
      presenceElement.append(chip);
    }

    const collaboratorCount = Math.max(0, participants.length - 1);
    presenceElement.setAttribute(
      "aria-label",
      collaboratorCount === 0
        ? "No other collaborators connected"
        : `${collaboratorCount} other collaborator${collaboratorCount === 1 ? "" : "s"} connected`,
    );

    const activeExpirations = typingParticipants
      .map((participant) => TYPING_LEASE_MS - (now - (participant.typingAt ?? now)))
      .filter((remaining) => remaining > 0);
    if (localOwnerIsTyping && localTypingAt !== undefined) {
      activeExpirations.push(TYPING_LEASE_MS - (now - localTypingAt));
    }
    if (activeExpirations.length > 0) {
      presenceTimer = window.setTimeout(renderPresence, Math.min(...activeExpirations) + 30);
    }
  };

  const stopLatencyProbe = (): void => {
    window.clearTimeout(latencyTimer);
    window.clearTimeout(latencyTimeout);
    pendingLatencyToken = undefined;
    latencyMilliseconds = null;
  };

  const renderConnectionStatus = (): void => {
    const online = lastStatus === "connected" && !waitingForEncryptionKey;
    const label = sessionConnectionLabel(lastStatus, waitingForEncryptionKey, latencyMilliseconds);
    statusElement.className = `status ${online ? "connected" : "offline"} state-${lastStatus}`;
    statusElement.setAttribute(
      "aria-label",
      label,
    );
    if (statusText) statusText.textContent = label;
    renderLatencyGraph();
  };

  /*
   * Says out loud that the machine is away. Without it the only sign is a grey
   * dot in the header, next to a terminal that has drawn nothing, which reads
   * as a broken page rather than a sleeping laptop.
   */
  const renderHostPresence = (): void => {
    window.clearTimeout(offlineNoticeTimer);
    const ended = stopped || lastStatus === "exited" || lastStatus === "missing";
    const away = !ended && hostIsAway(hostStatus);
    sessionPage.classList.toggle("session-host-away", away);
    if (!away) {
      offlineNotice.hidden = true;
      offlineNotice.replaceChildren();
      return;
    }

    const notice = hostNotice({
      status: hostStatus,
      hostLastSeenAt,
      screenCapturedAt: screenCapturedAt,
      hasScreen: hasTerminalContent,
      now: Date.now(),
    });
    if (!notice) {
      offlineNotice.hidden = true;
      return;
    }

    offlineNotice.classList.toggle("over-screen", notice.showingKeptScreen);
    const heading = document.createElement("strong");
    heading.textContent = notice.heading;
    const body = document.createElement("span");
    body.textContent = notice.body;
    offlineNotice.replaceChildren(heading, body);
    offlineNotice.hidden = false;
    /* "4 minutes ago" has to keep being true while nobody touches the page. */
    offlineNoticeTimer = window.setTimeout(renderHostPresence, 30_000);
  };

  const markTerminalContent = (): void => {
    if (hasTerminalContent) return;
    hasTerminalContent = true;
    renderHostPresence();
  };

  const setStatus = (status: string): void => {
    const wasConnected = lastStatus === "connected";
    lastStatus = status;
    if (status !== "connected") {
      stopLatencyProbe();
    } else if (!wasConnected) {
      latencyMilliseconds = null;
      scheduleLatencyProbe(0);
    }
    renderConnectionStatus();
    renderHostPresence();
    syncMobileKeys();
  };

  const scheduleLatencyProbe = (delay = 2_500): void => {
    window.clearTimeout(latencyTimer);
    if (stopped || lastStatus !== "connected") return;
    latencyTimer = window.setTimeout(sendLatencyProbe, delay);
  };

  const sendLatencyProbe = (): void => {
    if (socket?.readyState !== WebSocket.OPEN || lastStatus !== "connected") return;
    const token = crypto.getRandomValues(new Uint32Array(1))[0];
    pendingLatencyToken = token;
    pendingLatencyStarted = performance.now();
    sendBinaryFrame(encodeLatencyProbe(token));
    window.clearTimeout(latencyTimeout);
    latencyTimeout = window.setTimeout(() => {
      if (pendingLatencyToken !== token) return;
      pendingLatencyToken = undefined;
      latencyMilliseconds = null;
      renderConnectionStatus();
      scheduleLatencyProbe(1_000);
    }, 6_000);
  };

  const receiveLatencyResponse = (frame: Uint8Array): boolean => {
    const token = decodeLatencyProbe(frame);
    if (token === null) return false;
    if (token !== pendingLatencyToken) return true;
    window.clearTimeout(latencyTimeout);
    pendingLatencyToken = undefined;
    latencyMilliseconds = Math.max(1, Math.round(performance.now() - pendingLatencyStarted));
    recordLatencySample(latencyMilliseconds);
    renderConnectionStatus();
    scheduleLatencyProbe();
    return true;
  };

  const fitTerminal = (): void => {
    try {
      const box = terminalBox(terminalElement);
      if (box.width === 0 || box.height === 0) return;
      const current = readViewport();
      const typography = terminalTypography(
        compactSessionQuery.matches,
        mobileViewport.keyboardOpen,
        current.width,
        current.height,
      );
      /*
       * The typography for this device is the loosest the rows are drawn at;
       * the fit tightens the leading from there when that buys a larger font.
       */
      const fitted = fittedTerminal(
        box,
        { cols: terminalColumns, rows: terminalRows },
        measureCell,
        {
          zoomPercent: terminalZoomPercent,
          pixelRatio: window.devicePixelRatio,
          maxLineHeight: typography.lineHeight,
        },
      );
      if (terminal.options.fontSize !== fitted.fontSize) {
        terminal.options.fontSize = fitted.fontSize;
      }
      if (terminal.options.lineHeight !== fitted.lineHeight) {
        terminal.options.lineHeight = fitted.lineHeight;
      }
      if (terminal.cols !== terminalColumns || terminal.rows !== terminalRows) {
        terminal.resize(terminalColumns, terminalRows);
      } else {
        terminal.refresh(0, terminal.rows - 1);
      }
    } catch {
      // Layout can briefly be zero-sized during mobile viewport changes.
    }
  };

  const scheduleFit = (): void => {
    if (resizeFrame !== undefined) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = undefined;
      fitTerminal();
    });
  };

  const readViewport = (): { width: number; height: number } => ({
    width: Math.round(window.visualViewport?.width ?? window.innerWidth),
    height: Math.round(window.visualViewport?.height ?? window.innerHeight),
  });

  const isPortraitViewer = (): boolean => {
    // Keep the pre-keyboard layout while the visual viewport is compressed;
    // otherwise opening the keyboard would falsely turn a portrait phone into
    // a landscape viewer and resize the shared PTY underneath the user.
    if (mobileViewport.keyboardOpen && lastViewerPortrait !== undefined) {
      return lastViewerPortrait;
    }
    return window.innerHeight > window.innerWidth;
  };

  const reportViewerLayout = (): void => {
    const portrait = isPortraitViewer();
    if (portrait === lastViewerPortrait) return;
    lastViewerPortrait = portrait;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "viewer_layout", portrait }));
    }
  };

  const commitViewport = (
    current: { width: number; height: number },
    keyboardOpen: boolean,
  ): void => {
    const widthChanged = Math.abs(current.width - lastViewportWidth) >= 1;
    const heightChanged = Math.abs(current.height - lastViewportHeight) >= 1;
    const keyboardChanged = keyboardOpen !== lastKeyboardOpen;
    lastViewportWidth = current.width;
    lastViewportHeight = current.height;
    lastKeyboardOpen = keyboardOpen;
    sessionPage.classList.toggle("keyboard-open", keyboardOpen);
    if (heightChanged) {
      document.documentElement.style.setProperty("--session-viewport-height", `${current.height}px`);
    }
    if (widthChanged || heightChanged || keyboardChanged) scheduleFit();
    reportViewerLayout();
  };

  const handleViewportResize = (): void => {
    const current = readViewport();
    if (!compactSessionQuery.matches) {
      mobileViewport.reset();
      commitViewport(current, false);
      return;
    }

    const state = mobileViewport.observe(current.width, current.height);
    commitViewport(current, state.keyboardOpen);
  };

  const sampleViewportFrame = (): void => {
    viewportSampleFrame = undefined;
    handleViewportResize();
    if (performance.now() >= viewportSampleUntil) return;
    viewportSampleFrame = window.requestAnimationFrame(sampleViewportFrame);
  };

  const sampleViewportTransition = (duration = 650): void => {
    viewportSampleUntil = Math.max(viewportSampleUntil, performance.now() + duration);
    if (viewportSampleFrame !== undefined) return;
    viewportSampleFrame = window.requestAnimationFrame(sampleViewportFrame);
  };

  const handleViewportMotion = (): void => {
    handleViewportResize();
    sampleViewportTransition(320);
  };

  const showMissingSession = (): void => {
    stopped = true;
    sessionPage.classList.add("session-stopped");
    terminal.options.disableStdin = true;
    terminalWrites.enqueue(textEncoder.encode(
      "\x1b[2J\x1b[H\r\n  \x1b[1;37mSession no longer exists.\x1b[0m" +
      "\r\n  \x1b[90mThe task ended or the sharing link expired.\x1b[0m",
    ), true);
    setStatus("missing");
  };

  const showEndedSession = (): void => {
    stopped = true;
    sessionPage.classList.add("session-stopped");
    terminal.options.disableStdin = true;
    terminalWrites.enqueue(textEncoder.encode(
      "\r\n\r\n  \x1b[1;37mSession ended.\x1b[0m" +
      "\r\n  \x1b[90mThis sharing link no longer exists.\x1b[0m\r\n",
    ));
    setStatus("exited");
  };

  const showSessionFull = (): void => {
    if (!waitingForCapacity) {
      waitingForCapacity = true;
      sessionPage.classList.add("session-full");
      terminal.options.disableStdin = true;
      terminal.blur();
      helperTextarea?.blur();
      terminalWrites.enqueue(textEncoder.encode(
        "\x1b[2J\x1b[H\r\n  \x1b[1;37mSession is full.\x1b[0m" +
        `\r\n  \x1b[90m${MAX_SESSION_VIEWERS} viewers are connected. You will join automatically when a slot opens.\x1b[0m\r\n`,
      ), true);
    }
    setStatus("full");
  };

  const retryOrShowMissing = async (retryStatus = "disconnected"): Promise<void> => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.status === 404 || response.status === 410) {
        showMissingSession();
        return;
      }
    } catch {
      // A network outage is not evidence that the session ended.
    }

    if (stopped) return;
    setStatus(retryStatus);
    const delay = Math.min(10_000, 500 * 2 ** retryAttempt) + Math.random() * 250;
    retryAttempt += 1;
    retryTimer = window.setTimeout(connect, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    const finishConnect = beginProductOperation("terminal_connect");
    const finishUnlock = encryptedSession ? beginProductOperation("terminal_unlock") : () => {};
    setStatus(waitingForCapacity ? "full" : "connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const portrait = isPortraitViewer();
    lastViewerPortrait = portrait;
    const websocketURL = new URL(`${protocol}//${window.location.host}/api/sessions/${sessionId}/ws`);
    websocketURL.searchParams.set("layout", portrait ? "portrait" : "landscape");
    socket = new WebSocket(websocketURL);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      terminalInput.flush();
      scheduleFit();
      fileClient.probe();
      if (!waitingForCapacity && !compactSessionQuery.matches && !readOnly) terminal.focus();
    });

    let analyticsConnected = false;
    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      if (!analyticsConnected) {
        analyticsConnected = true;
        finishConnect("ok");
        trackProduct("terminal_connected");
      }
      if (typeof event.data === "string") {
        handleControlMessage(event.data);
        return;
      }

      const received = new Uint8Array(event.data);
      incomingFrames = incomingFrames.then(async () => {
        let frame = received;
        if (encryptedSession) {
          if (!frameCipher) return;
          try {
            frame = await frameCipher.open(received);
            finishUnlock("ok");
          } catch (error) {
            if (error instanceof E2EEReplayError) return;
            finishUnlock("denied");
            frameCipher = null;
            socket?.close(4003, "decryption failed");
            showEncryptionGate("That password could not decrypt this session. Check it and try again.", encryptionDescriptor?.kind === "password");
            return;
          }
        }
        if (frame.byteLength === 0) return;
        if (fileClient.handle(frame)) return;
        if (receiveLatencyResponse(frame)) return;
        if (isSnapshotOpcode(frame[0])) {
          const generation = ++terminalSnapshotGeneration;
          rendererInputSuppressed = true;
          terminalWrites.enqueue(frame.subarray(1), true, () => {
            if (generation === terminalSnapshotGeneration) rendererInputSuppressed = false;
          });
          snapshotRequestPending = false;
          markTerminalContent();
        } else if (frame[0] === Opcode.Output) {
          markTerminalContent();
          if (!terminalWrites.enqueue(frame.subarray(1)) && !snapshotRequestPending) {
            snapshotRequestPending = true;
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "snapshot_request" }));
            }
          }
        }
      }).catch(() => undefined);
    });

    socket.addEventListener("close", (event) => {
      finishConnect(terminalCloseOutcome(event.code));
      finishUnlock(terminalCloseOutcome(event.code));
      trackProduct("terminal_closed", { outcome: terminalCloseOutcome(event.code) });
      socket = null;
      fileClient.reset();
      terminalInput.clear();
      stopLatencyProbe();
      selfViewerId = null;
      participants = [];
      localTypingAt = undefined;
      renderPresence();
      if (event.code === 4004) {
        showMissingSession();
        return;
      }
      if (event.code === 4000) {
        showEndedSession();
        return;
      }
      if (isSessionFullClose(event.code)) {
        showSessionFull();
        void retryOrShowMissing("full");
        return;
      }
      if (waitingForEncryptionKey || stopped || lastStatus === "exited") return;
      setStatus("disconnected");
      void retryOrShowMissing();
    });

    socket.addEventListener("error", () => {
      // The close event owns retry behavior and produces a single state transition.
    });
  };

  const handleControlMessage = (raw: string): void => {
    let message: {
      type?: unknown;
      status?: unknown;
      label?: unknown;
      hostLastSeenAt?: unknown;
      lastScreenAt?: unknown;
      viewerId?: unknown;
      viewers?: unknown;
      agents?: unknown;
      mcpDecrypt?: unknown;
      localTypingAt?: unknown;
      readOnly?: unknown;
      encrypted?: unknown;
      persistent?: unknown;
      reason?: unknown;
      allowed?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }

    // Any server message means this retry was admitted. The next snapshot
    // replaces the capacity notice with the live terminal.
    retryAttempt = 0;
    waitingForCapacity = false;
    sessionPage.classList.remove("session-full");

    const messageReadOnly = readOnlyFromControlMessage(message);
    if (messageReadOnly !== null) applyReadOnly(messageReadOnly);
    if (typeof message.encrypted === "boolean") {
      if (encryptionDescriptor && !message.encrypted) {
        showEncryptionGate("The relay reported this encrypted link as plaintext. The connection was blocked.", false);
        socket?.close(4003, "encryption downgrade blocked");
        return;
      }
      applyEncryptionMode(message.encrypted);
    }
    if (typeof message.persistent === "boolean") {
      persistentSession = message.persistent;
      if (encryptedSession) applyEncryptionMode(true);
    }

    if (message.type === "access_denied" && message.reason === "read_only") {
      applyReadOnly(true);
      return;
    }

    if (message.type === "resize_control" && typeof message.allowed === "boolean") {
      // Older relays may still send resize-control messages. Sizing is now local to
      // each viewer and never changes the shared PTY.
      return;
    }
    /*
     * Any grid in range: a CLI that owns its grid runs at the size of the
     * terminal that started it, which is rarely one of the fixed grids.
     */
    if (message.type === "terminal_size" && isValidTerminalGrid(message.cols, message.rows)) {
      terminalColumns = message.cols as number;
      terminalRows = message.rows as number;
      scheduleFit();
      return;
    }

    if (message.type === "status" && typeof message.status === "string") {
      /*
       * The relay's status is the machine's, not this viewer's socket, which is
       * why it is kept apart from lastStatus.
       */
      hostStatus = message.status;
      hostLastSeenAt = typeof message.hostLastSeenAt === "string" ? message.hostLastSeenAt : undefined;
      screenCapturedAt = typeof message.lastScreenAt === "string" ? message.lastScreenAt : undefined;
      setStatus(message.status);
      if (typeof message.label === "string") {
        labelElement.textContent = message.label;
        document.title = `${message.label} — shell.online`;
      }
      return;
    }

    if (message.type === "welcome" && Number.isSafeInteger(message.viewerId)) {
      selfViewerId = Number(message.viewerId);
      renderPresence();
      return;
    }

    if (message.type !== "presence" || !Array.isArray(message.viewers)) return;
    participants = message.viewers.slice(0, 16).flatMap((candidate): PresenceParticipant[] => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const participant = candidate as Record<string, unknown>;
      if (
        !Number.isSafeInteger(participant.id) ||
        typeof participant.name !== "string" ||
        participant.name.length > 32 ||
        !Number.isInteger(participant.color) ||
        Number(participant.color) < 0 ||
        Number(participant.color) > 7 ||
        (participant.typingAt !== undefined && !Number.isFinite(participant.typingAt))
      ) {
        return [];
      }
      return [{
        id: Number(participant.id),
        name: participant.name,
        color: Number(participant.color),
        typingAt: participant.typingAt === undefined ? undefined : Number(participant.typingAt),
      }];
    });
    localTypingAt = Number.isFinite(message.localTypingAt)
      ? Number(message.localTypingAt)
      : undefined;
    activeAgents = Array.isArray(message.agents)
      ? message.agents.slice(0, 8).flatMap((candidate): string[] => {
          if (typeof candidate !== "object" || candidate === null) return [];
          const label = (candidate as Record<string, unknown>).label;
          return typeof label === "string" && label.length > 0 && label.length <= 64 ? [label] : [];
        })
      : [];
    mcpDecrypt = message.mcpDecrypt === true;
    // The server's MCP decryption capability changing alters the trust boundary: re-derive the
    // disclosure (the badge tracks the capability, not the presence chips).
    updateEncryptionDisclosure();
    renderPresence();
  };

  const sendInput = (bytes: Uint8Array): void => {
    if (readOnly || socket?.readyState !== WebSocket.OPEN) return;
    terminalInput.enqueue(bytes);
  };

  const clearDestructiveInputWarning = (): void => {
    window.clearTimeout(destructiveInputTimer);
    terminalInputWarning.hidden = true;
  };

  const confirmEOF = (): void => {
    if (readOnly || terminal.options.disableStdin || socket?.readyState !== WebSocket.OPEN) return;
    if (destructiveInput.confirm(performance.now())) {
      clearDestructiveInputWarning();
      sendBinaryFrame(new Uint8Array([Opcode.ConfirmedEOF]));
      return;
    }
    terminalInputWarning.textContent = "Ctrl-D can end this process. Press Ctrl-D again within 3 seconds to send EOF.";
    terminalInputWarning.hidden = false;
    window.clearTimeout(destructiveInputTimer);
    destructiveInputTimer = window.setTimeout(clearDestructiveInputWarning, 3_000);
  };

  terminal.attachCustomKeyEventHandler((event) => {
    const action = terminalKeyAction(event, terminal.hasSelection());
    if (action.kind === "default") return true;
    if (action.kind === "copy-selection") void copyToClipboard(terminal.getSelection());
    if (action.kind === "send") sendInput(action.bytes);
    return false;
  });

  const sendTerminalData = (bytes: Uint8Array): void => {
    // A raw terminal snapshot can contain old device-attribute queries from a
    // TUI startup. Replaying it must not answer those queries into the live
    // PTY after the application has already moved on.
    if (rendererInputSuppressed) return;
    if (bytes.byteLength === 1 && bytes[0] === 4) {
      confirmEOF();
      return;
    }
    destructiveInput.reset();
    clearDestructiveInputWarning();
    sendInput(bytes);
  };

  terminal.onData((data) => {
    sendTerminalData(textEncoder.encode(data));
  });
  const pasteTools = mountTerminalPaste({
    toolbar: document.querySelector<HTMLElement>("#terminal-paste-toolbar")!,
    overlay: document.querySelector<HTMLElement>(".session-page")!,
    canPaste: () => !stopped && !readOnly && !terminal.options.disableStdin && !rendererInputSuppressed && socket?.readyState === WebSocket.OPEN,
    paste: (text) => terminal.paste(text),
  });
  document.querySelector("#settings-signup")?.addEventListener("click", () => {
    trackProduct("feature_action", { target: "signup", action: "sign_up" });
  });

  const activateMobileKey = (button: HTMLButtonElement): void => {
    const bytes = mobileTerminalKeyBytes(button.dataset.terminalKey);
    if (bytes === null || button.disabled || terminal.options.disableStdin) return;
    terminal.focus();
    sendTerminalData(bytes);
  };

  for (const button of mobileKeyButtons) {
    button.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      activateMobileKey(button);
    });
    button.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      activateMobileKey(button);
    });
  }

  // Legacy mouse protocols and a few terminal query responses contain raw
  // bytes that must not pass through UTF-8 encoding.
  terminal.onBinary((data) => {
    sendTerminalData(Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff));
  });

  terminal.onTitleChange((title) => {
    const cleanTitle = title.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
    if (!cleanTitle) return;
    labelElement.textContent = cleanTitle;
    document.title = `${cleanTitle} — shell.online`;
  });

  copyButton.addEventListener("click", async () => {
    const attempt = ++copyAttempt;
    window.clearTimeout(copyResetTimer);
    copyButton.textContent = "Copying…";
    copyButton.dataset.state = "copying";
    try {
      await copyToClipboard(window.location.href);
      trackCopy("share");
      if (copyAttempt !== attempt) return;
      copyButton.textContent = "Copied";
      copyButton.dataset.state = "copied";
      copyResetTimer = window.setTimeout(() => {
        if (copyAttempt !== attempt) return;
        copyButton.textContent = defaultCopyLabel();
        delete copyButton.dataset.state;
      }, 1_500);
    } catch {
      if (copyAttempt !== attempt) return;
      copyButton.textContent = "Copy failed";
      copyButton.dataset.state = "failed";
      copyResetTimer = window.setTimeout(() => {
        if (copyAttempt !== attempt) return;
        copyButton.textContent = defaultCopyLabel();
        delete copyButton.dataset.state;
      }, 1_500);
    }
  });

  const openSettings = (): void => {
    terminal.blur();
    helperTextarea?.blur();
    renderLatencyGraph();
    if (settingsDialog.open) return;
    trackProduct("feature_action", { operation: "terminal_settings" });
    try {
      settingsDialog.showModal();
    } catch {
      settingsDialog.setAttribute("open", "");
    }
  };

  const closeSettings = (): void => {
    if (!settingsDialog.open) return;
    try {
      settingsDialog.close();
    } catch {
      settingsDialog.removeAttribute("open");
    }
  };

  settingsButton.addEventListener("click", openSettings);
  settingsCloseButton.addEventListener("click", closeSettings);
  settingsDialog.addEventListener("click", (event) => {
    if (event.target === settingsDialog) closeSettings();
  });

  const applyTerminalZoom = (zoomPercent: number, persist: boolean): void => {
    terminalZoomPercent = Math.min(150, Math.max(50, Math.round(zoomPercent)));
    zoomInput.value = String(terminalZoomPercent);
    zoomValue.value = `${terminalZoomPercent}%`;
    if (persist) {
      try {
        localStorage.setItem("shell-online-terminal-zoom", String(terminalZoomPercent));
      } catch {
        // Zoom remains active for this page when storage is unavailable.
      }
    }
    scheduleFit();
  };

  zoomInput.addEventListener("input", () => {
    applyTerminalZoom(Number(zoomInput.value), true);
  });

  let refstreamTools: { dispose(): void } | null = null;
  let refstreamToolsDisposed = false;
  void attachRefstreamTools(terminalRenderer, {
    terminal,
    toolbar: refstreamToolbar,
    overlay: terminalWrap,
    frame: terminalWrap,
    isActive: () => !stopped,
    onFontSizeChange: (size) => {
      applyTerminalZoom((size / 14) * 100, true);
    },
    exportFilename: `${sessionId}-terminal-output.txt`,
  }).then((tools) => {
    if (refstreamToolsDisposed) tools?.dispose();
    else refstreamTools = tools;
  });

  for (const button of themeOptionButtons) {
    button.addEventListener("click", () => {
      const preference = button.dataset.theme;
      if (preference === "system") {
        followsSystemTheme = true;
        try {
          localStorage.removeItem("shell-online-terminal-theme");
        } catch {
          // System following still works for this page when storage is unavailable.
        }
        applyColorMode(systemTheme.matches ? "light" : "dark", false);
      } else if (preference === "light" || preference === "dark") {
        applyColorMode(preference, true);
      }
      scheduleFit();
    });
  }

  themeButton.addEventListener("click", () => {
    applyColorMode(colorMode === "dark" ? "light" : "dark", true);
    scheduleFit();
    if (!compactSessionQuery.matches && !readOnly) terminal.focus();
  });

  systemTheme.addEventListener("change", (event) => {
    if (followsSystemTheme) applyColorMode(event.matches ? "light" : "dark", false);
  });

  const resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(terminalWrap);
  terminalElement.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && !readOnly) terminal.focus();
  });
  sessionHeader.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") terminal.blur();
  }, { passive: true });

  const terminalScrollSurface = terminalElement.querySelector<HTMLElement>(".xterm-screen");
  const touchLineScroller = new TerminalLineScroller(
    () => (terminalScrollSurface?.getBoundingClientRect().height ?? 0)
      / Math.max(terminal.rows, 1),
    (lines) => terminal.scrollLines(lines),
  );
  const pinchZoom = new TerminalPinchZoomGesture();
  const touchScroll = new TerminalTouchScrollBridge((wheel) => {
    if (
      terminal.buffer.active.type === "normal" &&
      terminal.modes.mouseTrackingMode === "none"
    ) {
      touchLineScroller.scrollPixels(wheel.deltaY);
      return;
    }

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: wheel.x,
      clientY: wheel.y,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: wheel.deltaY,
      view: window,
    });
    try {
      // xterm's cross-browser wheel normalizer prefers this legacy value when
      // present. Synthetic WheelEvents leave it at zero unless we provide it.
      Object.defineProperty(wheelEvent, "wheelDeltaY", {
        configurable: true,
        value: -wheel.deltaY * 3,
      });
    } catch {
      // Modern deltaY remains available if the legacy property is immutable.
    }
    terminalScrollSurface?.dispatchEvent(wheelEvent);
  });
  const readTouches = (touches: TouchList): TouchSample[] =>
    Array.from(touches, (touch) => ({
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
    }));
  terminalWrap.addEventListener("touchstart", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-terminal-ui]")) return;
    const touches = readTouches(event.touches);
    touchLineScroller.reset();
    touchScroll.start(touches);
    pinchZoom.start(touches, terminalZoomPercent);
  }, { passive: true });
  terminalWrap.addEventListener("touchmove", (event) => {
    const touches = readTouches(event.touches);
    const zoom = pinchZoom.move(touches);
    if (zoom !== null) {
      applyTerminalZoom(zoom, false);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!terminalScrollSurface || !touchScroll.move(touches)) return;
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
  terminalWrap.addEventListener("touchend", () => {
    touchLineScroller.reset();
    touchScroll.end();
    pinchZoom.end();
    applyTerminalZoom(terminalZoomPercent, true);
  }, { passive: true });
  terminalWrap.addEventListener("touchcancel", () => {
    touchLineScroller.reset();
    touchScroll.end();
    pinchZoom.end();
  }, { passive: true });

  helperTextarea?.addEventListener("focus", () => sampleViewportTransition());
  helperTextarea?.addEventListener("blur", () => sampleViewportTransition());

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleViewportMotion, { passive: true });
    window.visualViewport.addEventListener("scroll", handleViewportMotion, { passive: true });
  }
  window.addEventListener("resize", handleViewportMotion, { passive: true });
  window.addEventListener("orientationchange", () => sampleViewportTransition(800), { passive: true });
  compactPresenceQuery.addEventListener("change", renderPresence);
  window.addEventListener("beforeunload", () => {
    stopped = true;
    pasteTools.dispose();
    refstreamToolsDisposed = true;
    refstreamTools?.dispose();
    fileClient.dispose();
    fileBrowser.dispose();
    window.clearTimeout(retryTimer);
    window.clearTimeout(presenceTimer);
    window.clearTimeout(copyResetTimer);
    if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
    if (viewportSampleFrame !== undefined) window.cancelAnimationFrame(viewportSampleFrame);
    stopLatencyProbe();
    resizeObserver.disconnect();
    socket?.close(1000, "page closed");
  });

  encryptionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (encryptionDescriptor?.kind !== "password") return;
    const password = encryptionPassword.value;
    if (!password) return;
    encryptionPassword.disabled = true;
    encryptionMessage.textContent = "Deriving the decryption key on this device…";
    void BrowserFrameCipher.fromPassword(password, encryptionDescriptor.salt).then((cipher) => {
      frameCipher = cipher;
      encryptionPassword.value = "";
      waitingForEncryptionKey = false;
      encryptionGate.hidden = true;
      encryptionPassword.disabled = false;
      connect();
    }).catch(() => {
      encryptionPassword.disabled = false;
      encryptionMessage.textContent = "Could not derive the key. Try again.";
    });
  });

  handleViewportResize();
  void document.fonts?.ready.then(scheduleFit);
  requestAnimationFrame(() => void (async () => {
    fitTerminal();
    if (encryptionDescriptor?.kind === "key") {
      frameCipher = await BrowserFrameCipher.fromKey(encryptionDescriptor.key);
    } else if (encryptionDescriptor?.kind === "password") {
      if (!encryptionDescriptor.password) {
        showEncryptionGate("Use the password printed next to the link on the host computer, or ask the person who shared it.", true);
        return;
      }
      try {
        frameCipher = await BrowserFrameCipher.fromPassword(encryptionDescriptor.password, encryptionDescriptor.salt);
      } catch {
        showEncryptionGate("Could not derive the key. Enter the session password to try again.", true);
        return;
      }
    }
    connect();
  })());
}

function renderNotFound(): void {
  document.title = "Not found — shell.online";
  app!.innerHTML = `
    <section class="not-found">
      <a class="wordmark" href="/"><span>shell</span><i>.</i>online</a>
      <h1>Nothing is running here.</h1>
      <p>The sharing link may be incomplete or expired.</p>
      <a class="home-link" href="/">Back to shell.online</a>
    </section>
  `;
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
