import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  CLAUDE_CODE_PATH,
  CLINE_PATH,
  CURSOR_PATH,
  GEMINI_PATH,
  GITHUB_COPILOT_PATH,
  OPENCODE_PATH,
  WINDSURF_PATH,
} from "./agent-icons";
import "@xterm/xterm/css/xterm.css";
import {
  decodeLatencyProbe,
  encodeFrame,
  encodeLatencyProbe,
  encodeResize,
  MAX_INPUT_CHUNK,
  Opcode,
} from "../shared/protocol";
import { RELEASE_CHECKSUMS_PATH, RELEASE_VERSION } from "../shared/release";
import { TerminalWriteQueue } from "./terminal-writes";
import {
  appendLatencySample,
  buildLatencyPlot,
  parseLatencyHistory,
  summarizeLatency,
  type LatencySample,
} from "./latency-history";
import { MobileViewportTracker, terminalTypography } from "./mobile-viewport";
import { renderStatsDashboard } from "./stats";
import {
  TerminalLineScroller,
  TerminalTouchScrollBridge,
  type TouchSample,
} from "./touch-scroll";
import "./style.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing app root");

type TerminalColorMode = "dark" | "light";
const TYPING_LEASE_MS = 1_800;
const OPENAI_MARK_PATH = "M196.4 185.8l0-48.6c0-4.1 1.5-7.2 5.1-9.2l97.8-56.3c13.3-7.7 29.2-11.3 45.6-11.3 61.4 0 100.4 47.6 100.4 98.3 0 3.6 0 7.7-.5 11.8L343.3 111.1c-6.1-3.6-12.3-3.6-18.4 0L196.4 185.8zM424.7 375.2l0-116.2c0-7.2-3.1-12.3-9.2-15.9L287 168.4 329 144.3c3.6-2 6.7-2 10.2 0L437 200.7c28.2 16.4 47.1 51.2 47.1 85 0 38.9-23 74.8-59.4 89.6l0 0zM166.2 272.8l-42-24.6c-3.6-2-5.1-5.1-5.1-9.2l0-112.6c0-54.8 42-96.3 98.8-96.3 21.5 0 41.5 7.2 58.4 20L175.4 108.5c-6.1 3.6-9.2 8.7-9.2 15.9l0 148.5 0 0zm90.4 52.2l-60.2-33.8 0-71.7 60.2-33.8 60.2 33.8 0 71.7-60.2 33.8zm38.7 155.7c-21.5 0-41.5-7.2-58.4-20l100.9-58.4c6.1-3.6 9.2-8.7 9.2-15.9l0-148.5 42.5 24.6c3.6 2 5.1 5.1 5.1 9.2l0 112.6c0 54.8-42.5 96.3-99.3 96.3l0 0zM173.8 366.5L76.1 310.2c-28.2-16.4-47.1-51.2-47.1-85 0-39.4 23.6-74.8 59.9-89.6l0 116.7c0 7.2 3.1 12.3 9.2 15.9l128 74.2-42 24.1c-3.6 2-6.7 2-10.2 0zm-5.6 84c-57.9 0-100.4-43.5-100.4-97.3 0-4.1 .5-8.2 1-12.3l100.9 58.4c6.1 3.6 12.3 3.6 18.4 0l128.5-74.2 0 48.6c0 4.1-1.5 7.2-5.1 9.2l-97.8 56.3c-13.3 7.7-29.2 11.3-45.6 11.3l0 0zm127 60.9c62 0 113.7-44 125.4-102.4 57.3-14.9 94.2-68.6 94.2-123.4 0-35.8-15.4-70.7-43-95.7 2.6-10.8 4.1-21.5 4.1-32.3 0-73.2-59.4-128-128-128-13.8 0-27.1 2-40.4 6.7-23-22.5-54.8-36.9-89.6-36.9-62 0-113.7 44-125.4 102.4-57.3 14.8-94.2 68.6-94.2 123.4 0 35.8 15.4 70.7 43 95.7-2.6 10.8-4.1 21.5-4.1 32.3 0 73.2 59.4 128 128 128 13.8 0 27.1-2 40.4-6.7 23 22.5 54.8 36.9 89.6 36.9z";

interface AgentMark {
  label: string;
  path: string;
  viewBox?: string;
}

const AGENT_MARKS: readonly AgentMark[] = [
  { label: "Codex", path: OPENAI_MARK_PATH, viewBox: "0 0 512 512" },
  { label: "Claude Code", path: CLAUDE_CODE_PATH },
  { label: "Gemini CLI", path: GEMINI_PATH },
  { label: "GitHub Copilot", path: GITHUB_COPILOT_PATH },
  { label: "Cursor Agent", path: CURSOR_PATH },
  { label: "Windsurf", path: WINDSURF_PATH },
  { label: "Cline", path: CLINE_PATH },
  { label: "OpenCode", path: OPENCODE_PATH },
];

interface PresenceParticipant {
  id: number;
  name: string;
  color: number;
  typingAt?: number;
}

const terminalThemes: Record<TerminalColorMode, ITheme> = {
  dark: {
    background: "#0b0d12",
    foreground: "#eef1f6",
    cursor: "#dce6ff",
    cursorAccent: "#0b0d12",
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
    background: "#f8f9fb",
    foreground: "#202633",
    cursor: "#25304a",
    cursorAccent: "#f8f9fb",
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

const sessionMatch = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]{32})\/?$/);
const statsDashboard = window.location.hostname === "stats.shell.online" ||
  ((window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
    window.location.pathname === "/stats");

if (statsDashboard) {
  renderStatsDashboard(app);
} else if (sessionMatch) {
  renderTerminal(sessionMatch[1]);
} else if (window.location.pathname === "/" || window.location.pathname === "") {
  renderLanding();
} else {
  renderNotFound();
}

function renderLanding(): void {
  document.title = "shell.online — A live browser link for your terminal process";
  app!.innerHTML = `
    <section class="landing">
      <nav class="nav">
        <div class="nav-brand">
          <a class="wordmark" href="/" aria-label="shell.online home"><span>shell</span><i>.</i>online</a>
          <a class="release-link" href="${RELEASE_CHECKSUMS_PATH}" target="_blank" rel="noreferrer" title="Open SHA-256 checksums">v${RELEASE_VERSION} · SHA-256</a>
        </div>
        <div class="nav-agents">
          <div class="agent-marks" aria-label="Works with major terminal agents">
            ${renderAgentMarks()}
          </div>
          <button class="agents-link" type="button" data-copy-target="skill" data-copy-value="https://shell.online/skill" aria-label="Copy the shell.online agent skill URL">
            <span aria-live="polite">Copy skill</span>
          </button>
        </div>
      </nav>
      <div class="landing-stage">
        <div class="home-layout">
          <div class="hero">
          <h1>A live terminal. One browser link.</h1>
          <div class="lede use-case-reel" aria-label="Watch, share, control, hand off, or rejoin a terminal process from any device while it keeps running on your machine">
            <div class="use-case-track" aria-hidden="true">
              <span>Watch progress from your phone.</span>
              <span>Let someone you trust watch or type.</span>
              <span>Hand off Claude, Codex, or any TUI.</span>
              <span>Rejoin the same process locally.</span>
              <span>Share a fresh shell.</span>
              <span>Keep long-running work within reach.</span>
              <span>Google Docs for a live terminal.</span>
              <span>The process stays on your machine.</span>
              <span>Watch progress from your phone.</span>
            </div>
          </div>
          <section class="story-panel" aria-label="How shell.online works">
            <div class="story-heading">
              <span>How it works</span>
              <strong>Runs locally. Closes when the task exits.</strong>
            </div>
            <div class="story-grid">
              <article class="story-card">
                <div class="story-title"><span>1</span><strong>Get link</strong></div>
                <div class="story-shot story-link-shot" aria-hidden="true">
                  <i>↗</i>
                  <b>shell.online/s/k9f…</b>
                </div>
                <p>Prefix it with shell.</p>
              </article>
              <article class="story-card">
                <div class="story-title"><span>2</span><strong>Share</strong></div>
                <div class="story-shot story-share-shot" aria-hidden="true">
                  <span class="story-avatar">Y</span>
                  <span class="story-avatar">D</span>
                  <b>Link shared</b>
                  <i>↗</i>
                </div>
                <p>Link holders can view + type.</p>
              </article>
              <article class="story-card">
                <div class="story-title"><span>3</span><strong>Type</strong></div>
                <div class="story-shot story-collab-shot" aria-hidden="true">
                  <span class="story-avatar">Y</span>
                  <span class="story-avatar">D</span>
                  <b>Dodo is typing</b>
                </div>
                <p>One person types at a time.</p>
              </article>
              <article class="story-card">
                <div class="story-title"><span>4</span><strong>Watch</strong></div>
                <div class="story-shot story-monitor-shot" aria-hidden="true">
                  <div><span></span><b>train.py</b><em>42 ms</em></div>
                  <i><span></span></i>
                </div>
                <p>Watch from any device.</p>
              </article>
            </div>
          </section>
          </div>
          <div class="setup-card">
          <div class="setup-step">
            <span class="step-number">1</span>
            <div>
              <h2>Install the CLI <small>macOS + Linux · no sudo</small></h2>
              <div class="command-line">
                <code><span>curl -fsSL</span> <span>https://shell.online/install</span> <span>| sh</span></code>
                <button class="copy-command" type="button" data-copy-target="install" data-copy-value="curl -fsSL https://shell.online/install | sh" aria-label="Copy install command">
                  <span aria-live="polite">Copy</span>
                </button>
              </div>
            </div>
          </div>
          <div class="setup-step">
            <span class="step-number">2</span>
            <div>
              <h2>Prefix your command</h2>
              <div class="command-line">
                <code><span>shell</span> <span class="replaceable">&lt;your-command&gt;</span></code>
                <button class="copy-command" type="button" data-copy-target="run" data-copy-value="shell " aria-label="Copy the shell command prefix">
                  <span aria-live="polite">Copy prefix</span>
                </button>
              </div>
              <p class="replace-hint">Replace &lt;your-command&gt;. Runs in the background. Help: shell help.</p>
              <div class="command-examples" aria-label="Rotating examples of agents, training jobs, development servers, tests, containers, logs, remote shells, and terminal interfaces">
                <span class="examples-label">Examples</span>
                <div class="example-reel" aria-hidden="true">
                  <div class="example-track">
                    <span>shell python train.py</span>
                    <span>shell claude</span>
                    <span>shell codex</span>
                    <span>shell npm run dev</span>
                    <span>shell docker compose up</span>
                    <span>shell cargo test</span>
                    <span>shell pytest -x</span>
                    <span>shell tail -f app.log</span>
                    <span>shell ssh my-server</span>
                    <span>shell htop</span>
                    <span>shell vim README.md</span>
                    <span>shell</span>
                    <span>shell python train.py</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="share-result">
            <span>It prints a link like</span>
            <strong>shell.online/s/&lt;share-ID&gt;</strong>
          </div>
          <div class="command-reference" aria-label="Command reference">
            <div><code>shell</code><span>share a fresh shell</span></div>
            <div><code>shell list</code><span>list local shares</span></div>
            <div><code>shell attach &lt;ID&gt;</code><span>take over locally</span></div>
            <div><code>shell kill &lt;ID&gt;</code><span>stop process + link</span></div>
            <div><code>shell --foreground &lt;your-command&gt;</code><span>mirror it here too</span></div>
            <div><code>shell --auto-close 5m &lt;your-command&gt;</code><span>set an earlier close</span></div>
          </div>
          </div>
        </div>
      </div>
    </section>
  `;

  wireLandingCopyButtons();
  wireLandingFit();
}

function renderAgentMarks(): string {
  return AGENT_MARKS.map(
    ({ label, path, viewBox = "0 0 24 24" }) => `
      <span class="agent-mark" role="img" aria-label="${label}" title="${label}">
        <svg viewBox="${viewBox}" aria-hidden="true" focusable="false">
          <path d="${path}"></path>
        </svg>
      </span>
    `,
  ).join("");
}

function wireLandingFit(): void {
  const landing = document.querySelector<HTMLElement>(".landing");
  const stage = document.querySelector<HTMLElement>(".landing-stage");
  const layout = document.querySelector<HTMLElement>(".home-layout");
  if (!landing || !stage || !layout) return;

  let animationFrame = 0;
  let lastScale = "";
  let pointerIsDown = false;
  let fitWasDeferred = false;
  const fit = (): void => {
    if (pointerIsDown) {
      fitWasDeferred = true;
      return;
    }
    window.cancelAnimationFrame(animationFrame);
    animationFrame = window.requestAnimationFrame(() => {
      const stageStyle = window.getComputedStyle(stage);
      const landingStyle = window.getComputedStyle(landing);
      const availableWidth = stage.clientWidth
        - Number.parseFloat(stageStyle.paddingLeft)
        - Number.parseFloat(stageStyle.paddingRight);
      const availableHeight = stage.clientHeight
        - Number.parseFloat(stageStyle.paddingTop)
        - Number.parseFloat(stageStyle.paddingBottom);
      const preferredScale = Number.parseFloat(
        landingStyle.getPropertyValue("--landing-max-scale"),
      ) || 1;
      const widthScale = availableWidth / Math.max(layout.offsetWidth, 1);
      const heightScale = availableHeight / Math.max(layout.offsetHeight, 1);
      const scale = Math.max(0.1, Math.min(preferredScale, widthScale, heightScale));
      const nextScale = scale.toFixed(4);
      if (nextScale === lastScale) return;
      lastScale = nextScale;
      layout.style.setProperty("--landing-scale", nextScale);
    });
  };

  const lockFit = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") return;
    pointerIsDown = true;
    landing.classList.add("is-interacting");
  };
  const unlockFit = (): void => {
    if (!pointerIsDown) return;
    pointerIsDown = false;
    landing.classList.remove("is-interacting");
    if (!fitWasDeferred) return;
    fitWasDeferred = false;
    fit();
  };

  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(stage);
  resizeObserver.observe(layout);
  window.addEventListener("resize", fit, { passive: true });
  window.addEventListener("orientationchange", fit, { passive: true });
  landing.addEventListener("pointerdown", lockFit, { capture: true, passive: true });
  window.addEventListener("pointerup", unlockFit, { passive: true });
  window.addEventListener("pointercancel", unlockFit, { passive: true });
  void document.fonts.ready.then(fit);
  fit();
}

type CopyTarget = "install" | "run" | "share" | "skill";

function wireLandingCopyButtons(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".copy-command, .agents-link");
  const resetTimers = new WeakMap<HTMLButtonElement, number>();
  const copyAttempts = new WeakMap<HTMLButtonElement, number>();
  const defaultLabels = new WeakMap<HTMLButtonElement, string>();
  for (const button of buttons) {
    button.addEventListener("click", async () => {
      const target = button.dataset.copyTarget;
      const command = button.dataset.copyValue;
      const label = button.querySelector("span");
      if ((target !== "install" && target !== "run" && target !== "skill") || !command || !label) return;
      const defaultLabel = defaultLabels.get(button) ?? label.textContent ?? "Copy";
      defaultLabels.set(button, defaultLabel);
      const attempt = (copyAttempts.get(button) ?? 0) + 1;
      copyAttempts.set(button, attempt);
      window.clearTimeout(resetTimers.get(button));

      label.textContent = "Copying…";
      button.classList.remove("copied");
      try {
        await copyToClipboard(command);
        trackCopy(target);
        if (copyAttempts.get(button) !== attempt) return;
        label.textContent = "Copied";
        button.classList.add("copied");
      } catch {
        if (copyAttempts.get(button) !== attempt) return;
        label.textContent = "Try again";
      }

      const resetTimer = window.setTimeout(() => {
        if (copyAttempts.get(button) !== attempt) return;
        label.textContent = defaultLabel;
        button.classList.remove("copied");
      }, 1_500);
      resetTimers.set(button, resetTimer);
    });
  }
}

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
  void fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "copy", target }),
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => {
    // Copying should still succeed if analytics is unavailable.
  });
}

function renderTerminal(sessionId: string): void {
  document.title = "Shared terminal — shell.online";
  const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
  let followsSystemTheme = true;
  let colorMode: TerminalColorMode = systemTheme.matches ? "light" : "dark";
  let terminalZoomPercent = 100;
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
  } catch {
    // Storage may be disabled; system theme and default zoom still work.
  }
  app!.innerHTML = `
    <section class="session-page theme-${colorMode}">
      <header id="session-header" class="session-header">
        <a class="wordmark compact" href="/" target="_blank" rel="noreferrer"><span>shell</span><i>.</i>online</a>
        <div class="session-identity">
          <span id="session-label">terminal</span>
          <span id="session-status" class="status offline"><i></i><b>Offline</b></span>
          <span id="typing-status" class="typing-status" hidden></span>
        </div>
        <div class="session-actions">
          <div id="presence" class="presence" aria-label="No collaborators connected"></div>
          <button id="theme-toggle" class="theme-button" type="button">
            <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.25"></circle>
              <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.28 5.28l1.42 1.42M17.3 17.3l1.42 1.42M18.72 5.28 17.3 6.7M6.7 17.3l-1.42 1.42"></path>
            </svg>
            <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19.1 15.3A7.7 7.7 0 0 1 8.7 4.9 7.7 7.7 0 1 0 19.1 15.3Z"></path>
            </svg>
          </button>
          <button id="settings-open" class="settings-button" type="button" aria-label="Open terminal controls" title="Terminal controls" aria-haspopup="dialog" aria-controls="terminal-settings">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"></path>
            </svg>
            <span>Controls</span>
          </button>
        </div>
      </header>
      <div id="terminal-wrap" class="terminal-wrap">
        <div id="terminal" class="terminal" aria-label="Shared interactive terminal"></div>
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
            </div>
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
              <span>Anyone with the link can view and type.</span>
              <a href="${RELEASE_CHECKSUMS_PATH}" target="_blank" rel="noreferrer">v${RELEASE_VERSION} · SHA-256 checksums</a>
            </div>
          </footer>
        </div>
      </dialog>
    </section>
  `;

  const terminalElement = requiredElement("terminal");
  const terminalWrap = requiredElement("terminal-wrap");
  const sessionHeader = requiredElement("session-header");
  const sessionPage = document.querySelector<HTMLElement>(".session-page");
  if (!sessionPage) throw new Error("Missing session page");
  const statusElement = requiredElement("session-status");
  const statusText = statusElement.querySelector("b");
  const identityElement = document.querySelector<HTMLElement>(".session-identity");
  if (!identityElement) throw new Error("Missing session identity");
  const labelElement = requiredElement("session-label");
  const typingElement = requiredElement("typing-status");
  const presenceElement = requiredElement("presence");
  const copyButton = requiredElement<HTMLButtonElement>("settings-copy-link");
  const settingsButton = requiredElement<HTMLButtonElement>("settings-open");
  const settingsDialog = requiredElement<HTMLDialogElement>("terminal-settings");
  const settingsCloseButton = requiredElement<HTMLButtonElement>("settings-close");
  const themeButton = requiredElement<HTMLButtonElement>("theme-toggle");
  const zoomInput = requiredElement<HTMLInputElement>("terminal-zoom");
  const zoomValue = requiredElement<HTMLOutputElement>("zoom-value");
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

  const terminal = new Terminal({
    cursorBlink: !compactSessionQuery.matches,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    fontWeight: "400",
    fontWeightBold: "700",
    lineHeight: 1.18,
    letterSpacing: 0,
    scrollback: compactSessionQuery.matches ? 3_000 : 10_000,
    minimumContrastRatio: 4.5,
    drawBoldTextInBrightColors: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    scrollOnUserInput: true,
    allowTransparency: false,
    theme: terminalThemes[colorMode],
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(terminalElement);
  const helperTextarea = terminalElement.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
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
  );

  let socket: WebSocket | null = null;
  let stopped = false;
  let retryAttempt = 0;
  let retryTimer: number | undefined;
  let lastStatus = "waiting";
  let resizeFrame: number | undefined;
  let viewportSampleFrame: number | undefined;
  let viewportSampleUntil = 0;
  let lastViewportWidth = 0;
  let lastViewportHeight = 0;
  let lastKeyboardOpen = false;
  const mobileViewport = new MobileViewportTracker();
  let copyAttempt = 0;
  let copyResetTimer: number | undefined;
  let lastResizeSocket: WebSocket | null = null;
  let lastResizeColumns = 0;
  let lastResizeRows = 0;
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
  let presenceTimer: number | undefined;

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
      ?.setAttribute("content", colorMode === "dark" ? "#11141b" : "#f1f3f7");
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
    typingElement.hidden = !inputIsLocked;
    identityElement.classList.toggle("has-typing", inputIsLocked);
    terminalElement.classList.toggle("input-locked", inputIsLocked);
    terminal.options.disableStdin = stopped || inputIsLocked;

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
    const online = lastStatus === "connected" && latencyMilliseconds !== null;
    statusElement.className = `status ${online ? "connected" : "offline"} state-${lastStatus}`;
    statusElement.setAttribute(
      "aria-label",
      online ? `${latencyMilliseconds} millisecond round-trip latency to the shared machine` : "Offline",
    );
    if (statusText) statusText.textContent = online ? `${latencyMilliseconds} ms` : "Offline";
    renderLatencyGraph();
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
    socket.send(encodeLatencyProbe(token));
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

  const sendResize = (): void => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (
      socket === lastResizeSocket &&
      terminal.cols === lastResizeColumns &&
      terminal.rows === lastResizeRows
    ) return;
    socket.send(encodeResize(terminal.cols, terminal.rows));
    lastResizeSocket = socket;
    lastResizeColumns = terminal.cols;
    lastResizeRows = terminal.rows;
  };

  const fitTerminal = (): void => {
    if (terminalWrap.clientWidth === 0 || terminalWrap.clientHeight === 0) return;
    try {
      const current = readViewport();
      const typography = terminalTypography(
        compactSessionQuery.matches,
        mobileViewport.keyboardOpen,
        current.width,
        current.height,
      );
      const scaledFontSize = Math.max(
        4,
        Math.round(typography.fontSize * (terminalZoomPercent / 100) * 4) / 4,
      );
      if (terminal.options.fontSize !== scaledFontSize) {
        terminal.options.fontSize = scaledFontSize;
      }
      if (terminal.options.lineHeight !== typography.lineHeight) {
        terminal.options.lineHeight = typography.lineHeight;
      }
      fit.fit();
      sendResize();
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
    terminal.options.disableStdin = true;
    terminalWrites.enqueue(textEncoder.encode(
      "\x1b[2J\x1b[H\r\n  \x1b[1;37mSession no longer exists.\x1b[0m" +
      "\r\n  \x1b[90mThe task ended or the sharing link expired.\x1b[0m",
    ), true);
    setStatus("missing");
  };

  const showEndedSession = (): void => {
    stopped = true;
    terminal.options.disableStdin = true;
    terminalWrites.enqueue(textEncoder.encode(
      "\r\n\r\n  \x1b[1;37mSession ended.\x1b[0m" +
      "\r\n  \x1b[90mThis sharing link no longer exists.\x1b[0m\r\n",
    ));
    setStatus("exited");
  };

  const retryOrShowMissing = async (): Promise<void> => {
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
    setStatus("disconnected");
    const delay = Math.min(10_000, 500 * 2 ** retryAttempt) + Math.random() * 250;
    retryAttempt += 1;
    retryTimer = window.setTimeout(connect, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${window.location.host}/api/sessions/${sessionId}/ws`);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      retryAttempt = 0;
      lastResizeSocket = null;
      scheduleFit();
      if (!compactSessionQuery.matches) terminal.focus();
    });

    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === "string") {
        handleControlMessage(event.data);
        return;
      }

      const frame = new Uint8Array(event.data);
      if (frame.byteLength === 0) return;
      if (receiveLatencyResponse(frame)) return;
      if (frame[0] === Opcode.Snapshot) {
        terminalWrites.enqueue(frame.subarray(1), true);
      } else if (frame[0] === Opcode.Output) {
        terminalWrites.enqueue(frame.subarray(1));
      }
    });

    socket.addEventListener("close", (event) => {
      socket = null;
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
      if (stopped || lastStatus === "exited") return;
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
      viewerId?: unknown;
      viewers?: unknown;
      localTypingAt?: unknown;
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }

    if (message.type === "status" && typeof message.status === "string") {
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
    renderPresence();
  };

  const sendInput = (bytes: Uint8Array): void => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK) {
      socket.send(encodeFrame(Opcode.Input, bytes.subarray(offset, offset + MAX_INPUT_CHUNK)));
    }
  };

  terminal.onData((data) => {
    sendInput(textEncoder.encode(data));
  });

  // Legacy mouse protocols and a few terminal query responses contain raw
  // bytes that must not pass through UTF-8 encoding.
  terminal.onBinary((data) => {
    sendInput(Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff));
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
        copyButton.textContent = "Copy sharing link";
        delete copyButton.dataset.state;
      }, 1_500);
    } catch {
      if (copyAttempt !== attempt) return;
      copyButton.textContent = "Copy failed";
      copyButton.dataset.state = "failed";
      copyResetTimer = window.setTimeout(() => {
        if (copyAttempt !== attempt) return;
        copyButton.textContent = "Copy sharing link";
        delete copyButton.dataset.state;
      }, 1_500);
    }
  });

  const openSettings = (): void => {
    terminal.blur();
    helperTextarea?.blur();
    renderLatencyGraph();
    if (settingsDialog.open) return;
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

  zoomInput.addEventListener("input", () => {
    terminalZoomPercent = Number(zoomInput.value);
    zoomValue.value = `${terminalZoomPercent}%`;
    try {
      localStorage.setItem("shell-online-terminal-zoom", String(terminalZoomPercent));
    } catch {
      // Zoom remains active for this page when storage is unavailable.
    }
    scheduleFit();
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
    if (!compactSessionQuery.matches) terminal.focus();
  });

  systemTheme.addEventListener("change", (event) => {
    if (followsSystemTheme) applyColorMode(event.matches ? "light" : "dark", false);
  });

  const resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(terminalWrap);
  terminalElement.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") terminal.focus();
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
    touchLineScroller.reset();
    touchScroll.start(readTouches(event.touches));
  }, { passive: true });
  terminalWrap.addEventListener("touchmove", (event) => {
    if (!terminalScrollSurface || !touchScroll.move(readTouches(event.touches))) return;
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
  terminalWrap.addEventListener("touchend", () => {
    touchLineScroller.reset();
    touchScroll.end();
  }, { passive: true });
  terminalWrap.addEventListener("touchcancel", () => {
    touchLineScroller.reset();
    touchScroll.end();
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
    window.clearTimeout(retryTimer);
    window.clearTimeout(presenceTimer);
    window.clearTimeout(copyResetTimer);
    if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
    if (viewportSampleFrame !== undefined) window.cancelAnimationFrame(viewportSampleFrame);
    stopLatencyProbe();
    resizeObserver.disconnect();
    socket?.close(1000, "page closed");
  });

  handleViewportResize();
  void document.fonts?.ready.then(scheduleFit);
  requestAnimationFrame(() => {
    fitTerminal();
    connect();
  });
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
