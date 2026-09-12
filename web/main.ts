import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  decodeLatencyProbe,
  encodeFrame,
  encodeLatencyProbe,
  isSnapshotOpcode,
  Opcode,
} from "../shared/protocol";
import { readOnlyFromControlMessage } from "../shared/session-access";
import {
  isSessionFullClose,
  MAX_SESSION_VIEWERS,
} from "../shared/session-capacity";
import { RELEASE_CHECKSUMS_PATH, RELEASE_VERSION } from "../shared/release";
import {
  formatGitHubStarCount,
  GITHUB_REPOSITORY_URL,
  readGitHubSummaryStarCount,
} from "../shared/github";
import { TerminalWriteQueue } from "./terminal-writes";
import { TerminalInputQueue } from "./terminal-input";
import { mobileTerminalKeyBytes, terminalKeyAction } from "./terminal-keyboard";
import { DestructiveInputGuard } from "./destructive-input";
import { BrowserFrameCipher, parseEncryptionFragment } from "./e2ee";
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
  LEGACY_MOBILE_TERMINAL_GRID,
  MOBILE_TERMINAL_GRID,
} from "../shared/terminal-grid";
import { renderStatsDashboard } from "./stats";
import {
  TerminalLineScroller,
  TerminalPinchZoomGesture,
  TerminalTouchScrollBridge,
  type TouchSample,
} from "./touch-scroll";
import "./style.css";
import "./landing.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing app root");

type TerminalColorMode = "dark" | "light";
const TYPING_LEASE_MS = 1_800;
const PILOT_PROTOCOL_URL = "https://pilotprotocol.network/";

/*
 * Where the web app is served. It is a separate Worker from this one -- the
 * relay serves the marketing pages and /s/<id>, nothing else -- so its host is
 * not derivable from anything here and lives in one place instead.
 */
const WEB_APP_URL = "https://app.shell.online";
const SIGNUP_URL = `${WEB_APP_URL}/signup`;
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
  const windowsVisitor = /Windows/i.test(navigator.userAgent);
  const installCommand = windowsVisitor
    ? "irm https://shell.online/install.ps1 | iex"
    : "curl -fsSL https://shell.online/install | sh";
  const installPrompt = windowsVisitor ? "PS>" : "$";
  document.title = "Share a Live Terminal in Any Browser | shell.online";
  document.documentElement.classList.add("marketing-root");
  document.body.classList.add("marketing-body");
  app!.innerHTML = `
    <section class="marketing">
      <header class="marketing-nav">
        <a class="wordmark" href="/" aria-label="shell.online home"><span>shell</span><i>.</i>online</a>
        <nav class="marketing-links" aria-label="Main navigation">
          <a href="/docs/">Docs</a>
          <a href="#use-cases">Use cases</a>
          <a class="marketing-github-link" href="${GITHUB_REPOSITORY_URL}" target="_blank" rel="noreferrer" aria-label="Star shell.online on GitHub">★ GitHub <span id="github-star-count" aria-live="polite">—</span></a>
          <button class="nav-install" type="button" data-copy-target="install" data-copy-value="${installCommand}" aria-label="Copy the shell.online install command">
            <span data-copy-label aria-live="polite">Copy install</span>
          </button>
          <a class="nav-signup" href="${SIGNUP_URL}">Sign up free</a>
        </nav>
      </header>

      <main>
        <section class="marketing-hero">
          <div class="hero-copy">
            <h1>Run it here.<br /><em>Open it anywhere.</em></h1>
            <p class="hero-dek">Run <code>shell &lt;command&gt;</code> on your machine. It gives you a link and password to the same encrypted terminal—open it from any desktop or phone to watch or type.</p>
            <div class="hero-actions">
              <a class="hero-signup" href="${SIGNUP_URL}">
                <b>Sign up free</b>
                <span aria-hidden="true">→</span>
              </a>
              <button class="install-command${windowsVisitor ? " install-command-windows" : ""}" type="button" data-copy-target="install" data-copy-value="${installCommand}" aria-label="Copy install command">
                <span class="command-prompt" aria-hidden="true">${installPrompt}</span>
                <code>${installCommand}</code>
                <span class="command-copy-label" data-copy-label aria-live="polite">Copy</span>
              </button>
              <div class="hero-secondary-actions">
                <a class="text-link" href="#how">See how it works <span aria-hidden="true">↓</span></a>
              </div>
            </div>
          </div>

          <div class="product-demo phone-product-demo" aria-label="A live shell.online agent session viewed on a phone">
            <div class="demo-aura" aria-hidden="true"></div>
            <figure class="real-phone-demo">
              <div class="phone-device">
                <div class="hero-phone-screen">
                  <div class="hero-phone-head">
                    <strong>shell.online</strong>
                    <span class="hero-phone-latency"><i></i> 22 ms</span>
                    <span class="hero-phone-viewers" aria-label="One viewer">1</span>
                    <span class="hero-phone-control" aria-hidden="true">☼</span>
                    <span class="hero-phone-control hero-phone-settings" aria-hidden="true"></span>
                  </div>
                  <div class="hero-phone-terminal">
                    <div class="hero-agent-title">
                      <span class="hero-agent-mark" aria-hidden="true">✦</span>
                      <span><strong>Claude Code</strong><small>Sonnet · ~/project</small></span>
                    </div>
                    <div class="hero-agent-prompt"><span>❯</span> Fix the failing heartbeat test</div>
                    <p>I found the race in the deadline check. I’m adding a regression test now.</p>
                    <div class="hero-agent-command"><span>›</span> go test ./...</div>
                    <div class="hero-agent-result"><i>✓</i><span><strong>Fixed</strong><small>42 tests pass · 1.8s</small></span></div>
                    <div class="hero-agent-input"><span>❯</span><i></i></div>
                  </div>
                  <div class="hero-phone-keys" aria-hidden="true">
                    <span>esc</span><span>tab</span><span>←</span><span>↑</span><span>↓</span><span>→</span><span>enter</span><span>ctrl-c</span>
                  </div>
                </div>
              </div>
              <figcaption><span><i></i> Interactive in any browser</span><strong>Claude Code · live via shell.online</strong></figcaption>
            </figure>
          </div>
        </section>

        <section class="use-strip" aria-label="Use shell.online with any terminal process">
          <p>One prefix. Whatever you already run.</p>
          <div>
            <code>shell claude</code>
            <code>shell codex</code>
            <code>shell python train.py</code>
            <code>shell docker compose up</code>
            <code>shell terraform apply</code>
            <code>shell ssh my-server</code>
            <code>shell htop</code>
            <code>shell bash</code>
            <code>shell --read-only python train.py</code>
          </div>
        </section>

        <section class="how-section" id="how">
          <div class="section-heading">
            <p>How a share works</p>
            <h2>A share link,<br />not a remote machine.</h2>
            <span>The command and PTY stay where you started them. shell.online relays encrypted terminal frames to people holding the link and browser password.</span>
          </div>
          <div class="steps-grid">
            <article class="step-card">
              <span class="step-index">01</span>
              <div class="step-visual step-command" aria-hidden="true"><code><i>$</i> shell python train.py</code><b></b></div>
              <h3>Prefix the command</h3>
              <p>Start any CLI, agent, server, job, TUI, or fresh shell exactly where it already lives.</p>
            </article>
            <article class="step-card">
              <span class="step-index">02</span>
              <div class="step-visual step-share" aria-hidden="true">
                <div><i>↗</i><code>shell.online/s/k9f…</code></div>
                <span>Password · Ab3dE7-_</span>
              </div>
              <h3>Send the link and password</h3>
              <p>No SSH keys to exchange. Choose interactive or server-enforced view-only access, then send both values to the people you trust.</p>
            </article>
            <article class="step-card">
              <span class="step-index">03</span>
              <div class="step-visual step-collab" aria-hidden="true">
                <div><span>Y</span><span>M</span><span>R</span></div>
                <p><i></i> Maya is typing</p>
              </div>
              <h3>Watch, or type together</h3>
              <p>Use read-only to follow progress safely, or keep the default interactive mode to take control and pair in the same terminal.</p>
            </article>
          </div>
          <aside class="product-path" aria-label="More ways to use shell.online">
            <a href="${SIGNUP_URL}"><b>Manage a team</b><span>Link machines, open sessions, assign work.</span><i>→</i></a>
            <a href="/e2ee/"><b>Understand E2EE</b><span>See exactly what the relay can and cannot read.</span><i>→</i></a>
            <a href="/skill"><b>Install for agents</b><span>Give terminal-native agents the same workflow.</span><i>→</i></a>
          </aside>
        </section>

        <section class="use-cases-section" id="use-cases">
          <div class="section-heading use-cases-heading">
            <p>Use cases</p>
            <h2>One live link.<br />Plenty to keep moving.</h2>
            <span>Use shell.online anywhere a terminal process outlasts your attention, needs a second pair of eyes, or asks for input while you are away. Access is interactive by default; add <code>--read-only</code> when recipients should only watch.</span>
          </div>
          <div class="use-cases-grid">
            <article class="use-case-card">
              <header><span>01</span><i>AI agents</i></header>
              <h3>Watch coding agents from your phone</h3>
              <p>Follow Codex or Claude Code while it explores, edits, and tests. Answer a prompt without returning to the computer that started it.</p>
              <code><b>$</b> shell codex</code>
            </article>
            <article class="use-case-card">
              <header><span>02</span><i>Builds + tests</i></header>
              <h3>Keep long test suites within reach</h3>
              <p>Watch compilation and test output live, inspect a failure, or interrupt a stuck run from another device.</p>
              <code><b>$</b> shell go test -race ./...</code>
            </article>
            <article class="use-case-card">
              <header><span>03</span><i>ML + data</i></header>
              <h3>Follow training and data jobs</h3>
              <p>Check progress logs for model training, ETL jobs, migrations, and batch scripts without granting browser control.</p>
              <code><b>$</b> shell --read-only python train.py</code>
            </article>
            <article class="use-case-card">
              <header><span>04</span><i>Local servers</i></header>
              <h3>Carry development logs with you</h3>
              <p>Open a live window into development servers, Docker stacks, file watchers, and other processes that keep printing.</p>
              <code><b>$</b> shell docker compose up</code>
            </article>
          </div>
        </section>

        <section class="demo-proof">
          <div class="demo-proof-heading">
            <p>Captured live, not a mockup</p>
            <h2>Follow the work.<br />See the result.</h2>
            <span>The same real Codex session, captured on a phone while it diagnosed and fixed a heartbeat timeout, then passed the package tests and Go’s race detector.</span>
          </div>
          <div class="demo-proof-grid">
            <figure class="phone-proof">
              <div class="phone-proof-screen">
                <img src="/screenshots/codex-working-mobile.png" width="780" height="1688" alt="Codex diagnosing a failing heartbeat test through shell.online on a phone" loading="lazy" />
              </div>
              <figcaption><b>Working</b><span>Follow the diagnosis and live test output.</span></figcaption>
            </figure>
            <figure class="phone-proof">
              <div class="phone-proof-screen">
                <img src="/screenshots/codex-complete-mobile.png" width="780" height="1688" alt="The completed Codex fix with passing tests viewed through shell.online on a phone" loading="lazy" />
              </div>
              <figcaption><b>Complete</b><span>Review the fix and the passing test suite.</span></figcaption>
            </figure>
          </div>
        </section>

        <section class="install-paths" id="install">
          <div class="install-paths-heading">
            <p>Install your way</p>
            <h2>Three ways<br />to install.</h2>
            <span>Use Homebrew, the verified standalone installer, or build the tagged source yourself.</span>
          </div>
          <div class="install-path-grid">
            <article class="install-path-card install-path-primary">
              <div class="install-path-meta"><span>Homebrew</span><strong>Managed install</strong></div>
              <h3>Let Brew build and manage it.</h3>
              <button class="method-command method-command-brew" type="button" data-copy-target="brew_install" data-copy-value="brew tap teoslayer/shell-online https://github.com/TeoSlayer/shell.online&#10;brew trust --tap teoslayer/shell-online&#10;brew install shell-online" aria-label="Copy the Homebrew tap, trust, and install commands">
                <code><span>brew tap teoslayer/shell-online …</span><span>brew trust --tap teoslayer/shell-online</span><span>brew install shell-online</span></code>
                <span data-copy-label aria-live="polite">Copy setup</span>
              </button>
              <ul>
                <li>Fetches the checksum-pinned tagged source.</li>
                <li>Installs Go as a build-only dependency and compiles locally.</li>
                <li>Homebrew 6 asks you to trust this vendor tap once.</li>
                <li>Upgrades are simply <code>brew upgrade shell-online</code>.</li>
              </ul>
            </article>
            <article class="install-path-card">
              <div class="install-path-meta"><span>No Brew</span><strong>Verified download</strong></div>
              <h3>Use the standalone installer.</h3>
              <button class="method-command" type="button" data-copy-target="install" data-copy-value="${installCommand}" aria-label="Copy the shell.online installer command">
                <code>${installCommand}</code>
                <span data-copy-label aria-live="polite">Copy</span>
              </button>
              <ul>
                <li>Detects Windows, macOS, Linux, BSD, Solaris, and 15 architectures.</li>
                <li>Verifies SHA-256 before installing.</li>
                <li>Never invokes sudo or edits your shell files.</li>
              </ul>
            </article>
            <article class="install-path-card install-path-source">
              <div class="install-path-meta"><span>Source</span><strong>Go 1.26.8</strong></div>
              <h3>Build it yourself. Run it anywhere.</h3>
              <button class="method-command" type="button" data-copy-target="source_build" data-copy-value="git clone --depth 1 --branch v${RELEASE_VERSION} https://github.com/TeoSlayer/shell.online.git &amp;&amp; cd shell.online &amp;&amp; go build -trimpath -ldflags='-X main.version=${RELEASE_VERSION}' -o ./shell ./cmd/shell" aria-label="Copy the source build commands">
                <code><span>git clone … shell.online.git</span><span>go build -o ./shell ./cmd/shell</span></code>
                <span data-copy-label aria-live="polite">Copy build</span>
              </button>
              <ul>
                <li>Checks out the exact tagged release source.</li>
                <li>Produces <code>./shell</code> inside your clone.</li>
                <li>Run it there or move it to any directory on your PATH.</li>
              </ul>
            </article>
          </div>
        </section>

      </main>

      <footer class="marketing-footer">
        <a class="wordmark" href="/" aria-label="shell.online home"><span>shell</span><i>.</i>online</a>
        <p>Live browser terminals for the work your machine is already doing.<span>Developed by <a href="${PILOT_PROTOCOL_URL}" target="_blank" rel="noreferrer">Pilot Protocol</a>.</span></p>
        <nav aria-label="Footer navigation">
          <a href="/docs/">Docs</a>
          <a href="${SIGNUP_URL}">Web app</a>
          <a href="#use-cases">Use cases</a>
          <a href="/mobile/">Mobile</a>
          <a href="/reliability/">Reliability</a>
          <a href="/security/">Security</a>
          <a href="/e2ee/">E2EE</a>
          <a href="/docker/">Docker</a>
          <a href="/platforms/">Platforms</a>
          <a href="${GITHUB_REPOSITORY_URL}" target="_blank" rel="noreferrer">Star on GitHub</a>
          <a href="/skill">Agent skill</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="${RELEASE_CHECKSUMS_PATH}" target="_blank" rel="noreferrer">v${RELEASE_VERSION} · SHA-256</a>
        </nav>
      </footer>
    </section>
  `;

  wireLandingCopyButtons();
  void wireGitHubStarCount();
}

async function wireGitHubStarCount(): Promise<void> {
  const link = document.querySelector<HTMLAnchorElement>(".marketing-github-link");
  const count = document.querySelector<HTMLElement>("#github-star-count");
  if (!link || !count) return;

  try {
    const response = await fetch("/api/github", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;

    const stars = readGitHubSummaryStarCount(await response.json());
    if (stars === null) return;

    count.textContent = formatGitHubStarCount(stars);
    const exactCount = stars.toLocaleString("en-US");
    const noun = stars === 1 ? "star" : "stars";
    link.title = `${exactCount} GitHub ${noun}`;
    link.setAttribute(
      "aria-label",
      `Open shell.online on GitHub — ${exactCount} ${noun}`,
    );
  } catch {
    // The repository link remains useful when GitHub's API is unavailable.
  }
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

type CopyTarget = "install" | "brew_install" | "source_build" | "run" | "share" | "skill";

function wireLandingCopyButtons(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-copy-target][data-copy-value]");
  const resetTimers = new WeakMap<HTMLButtonElement, number>();
  const copyAttempts = new WeakMap<HTMLButtonElement, number>();
  const defaultLabels = new WeakMap<HTMLButtonElement, string>();
  for (const button of buttons) {
    button.addEventListener("click", async () => {
      const target = button.dataset.copyTarget;
      const command = button.dataset.copyValue;
      const label = button.querySelector<HTMLElement>("[data-copy-label]");
      if (
        (target !== "install" &&
          target !== "brew_install" &&
          target !== "source_build" &&
          target !== "run" &&
          target !== "skill") ||
        !command ||
        !label
      ) return;
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
  const encryptionDescriptor = parseEncryptionFragment(window.location.hash);
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
          <span id="session-access" class="session-access" hidden>View only</span>
          <span id="session-encryption" class="session-access encryption" hidden>End-to-end encrypted</span>
          <span id="session-status" class="status offline" role="status" aria-live="polite"><i></i><b>Offline</b></span>
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
        <div id="terminal-input-warning" class="terminal-input-warning" role="status" aria-live="assertive" hidden></div>
      </div>
      <nav id="mobile-terminal-keys" class="mobile-terminal-keys" aria-label="Terminal navigation keys">
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
          <p id="encryption-message">The password is processed on this device and is never sent to shell.online.</p>
          <label for="encryption-password">Password</label>
          <input id="encryption-password" type="password" required autocomplete="new-password" autocapitalize="off" spellcheck="false" />
          <button type="submit">Decrypt terminal</button>
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
  const terminalInputWarning = requiredElement("terminal-input-warning");
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
  const encryptionGate = requiredElement("encryption-gate");
  const encryptionForm = requiredElement<HTMLFormElement>("encryption-form");
  const encryptionPassword = requiredElement<HTMLInputElement>("encryption-password");
  const encryptionMessage = requiredElement("encryption-message");
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
  const measureCell = cellMeasurer(terminal.options.fontFamily ?? "monospace");
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
  let presenceTimer: number | undefined;
  let readOnly = false;
  let snapshotRequestPending = false;
  const terminalInput = new TerminalInputQueue(() => socket);
  const destructiveInput = new DestructiveInputGuard();
  let destructiveInputTimer: number | undefined;
  let frameCipher: BrowserFrameCipher | null = null;
  let encryptedSession = false;
  let persistentSession = false;
  let waitingForEncryptionKey = false;
  let waitingForCapacity = false;
  let outgoingFrames = Promise.resolve();
  let incomingFrames = Promise.resolve();

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

  const showEncryptionGate = (message: string, allowPassword: boolean): void => {
    waitingForEncryptionKey = true;
    encryptionGate.hidden = false;
    encryptionMessage.textContent = message;
    encryptionPassword.hidden = !allowPassword;
    encryptionForm.querySelector<HTMLLabelElement>("label")!.hidden = !allowPassword;
    encryptionForm.querySelector<HTMLButtonElement>("button")!.hidden = !allowPassword;
    terminal.options.disableStdin = true;
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

  const applyEncryptionMode = (encrypted: boolean): void => {
    encryptedSession = encrypted;
    encryptionBadge.hidden = false;
    encryptionBadge.classList.toggle("unencrypted", !encrypted);
    const fullLabel = encrypted
      ? persistentSession ? "Persistent E2EE" : "End-to-end encrypted"
      : "Transport only";
    encryptionBadge.textContent = fullLabel;
    encryptionBadge.setAttribute("aria-label", fullLabel);
    encryptionBadge.dataset.compactLabel = encrypted ? persistentSession ? "Persistent" : "E2EE" : "Transport";
    renderAccessDescription();
    if (encrypted && !frameCipher && !encryptionDescriptor) {
      showEncryptionGate("This E2EE link is missing its decryption fragment. Ask the sender for the complete URL, including everything after #.", false);
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
    const waitingForSlot = lastStatus === "full";
    statusElement.className = `status ${online ? "connected" : "offline"} state-${lastStatus}`;
    statusElement.setAttribute(
      "aria-label",
      online
        ? `${latencyMilliseconds} millisecond round-trip latency to the shared machine`
        : waitingForSlot
          ? `Session full; waiting for one of ${MAX_SESSION_VIEWERS} viewer slots`
          : "Offline",
    );
    if (statusText) statusText.textContent = online ? `${latencyMilliseconds} ms` : waitingForSlot ? "Full · waiting" : "Offline";
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
      if (!waitingForCapacity && !compactSessionQuery.matches && !readOnly) terminal.focus();
    });

    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
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
          } catch {
            frameCipher = null;
            socket?.close(4003, "decryption failed");
            showEncryptionGate("That password could not decrypt this session. Check it and try again.", encryptionDescriptor?.kind === "password");
            return;
          }
        }
        if (frame.byteLength === 0) return;
        if (receiveLatencyResponse(frame)) return;
        if (isSnapshotOpcode(frame[0])) {
          terminalWrites.enqueue(frame.subarray(1), true);
          snapshotRequestPending = false;
        } else if (frame[0] === Opcode.Output) {
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
      socket = null;
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
      viewerId?: unknown;
      viewers?: unknown;
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
    if (typeof message.encrypted === "boolean") applyEncryptionMode(message.encrypted);
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
    if (
      message.type === "terminal_size" &&
      typeof message.cols === "number" &&
      typeof message.rows === "number" &&
      [DESKTOP_TERMINAL_GRID, MOBILE_TERMINAL_GRID, LEGACY_MOBILE_TERMINAL_GRID].some(
        (grid) => message.cols === grid.cols && message.rows === grid.rows,
      )
    ) {
      terminalColumns = message.cols;
      terminalRows = message.rows;
      scheduleFit();
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
        showEncryptionGate("The password is processed on this device and is never sent to shell.online.", true);
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
