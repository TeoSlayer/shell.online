import { RELEASE_VERSION } from "../shared/release";
import { sourceBuildCommands } from "../shared/source-build";
import {
  AGENT_BRANDS,
  agentGrid,
  brandMark,
  agentPicker,
  platformPicker,
} from "./landing-brands";

/** Static, public copy. No account or terminal data belongs in this page. */
export function landingMarkup(): string {
  return `<div class="home">
    <header class="home-nav wrap">
      <a class="home-logo" href="/" aria-label="shell.online home">shell<span>.</span>online</a>
      <nav aria-label="Main navigation"><a href="#how">How it works</a><a href="/docs/">Docs</a><a href="https://app.shell.online/" class="home-login">Log in</a><a class="button small" href="#start" data-cta="start_nav">Get started</a></nav>
    </header>
    <main>
      <section class="home-hero wrap" aria-labelledby="home-title">
        <div class="home-pitch">
          <p class="eyebrow">Your coding agent. On your phone.</p>
          <h1 id="home-title">Leave your desk.<br><span>Keep your agent moving.</span></h1>
          <p class="home-dek">Check progress. Reply to prompts.<br>Your agent stays on your computer. You don’t have to.</p>
          <div class="home-actions"><a class="button" href="#start" data-cta="start_hero">Start your first session <span aria-hidden="true">↗</span></a><a class="quiet-link" href="#see-it" data-cta="demo">See a real session <span aria-hidden="true">↓</span></a></div>
          <p class="home-reassurance">Free and open source. No account needed to try it.</p>
          <div class="hero-agent-brands" aria-label="Bring your favorite agent">${AGENT_BRANDS.slice(
            0,
            4,
          )
            .map(([name, file]) => brandMark(name, file, true))
            .join(
              "",
            )}<a href="#agents">See all agents <span aria-hidden="true">↓</span></a></div>
        </div>
        <figure class="home-proof" id="see-it">
          <div class="proof-caption"><span class="proof-dot" aria-hidden="true"></span> Real session · viewed on a phone</div>
          <div class="proof-window"><img id="proof-image" src="/screenshots/codex-working-mobile.png" width="780" height="1688" fetchpriority="high" alt="A real Codex session in the phone browser, investigating a failing test."></div>
          <div class="proof-switch" role="group" aria-label="View real session screenshots"><button type="button" data-proof="working" aria-pressed="true">Working</button><button type="button" data-proof="complete" aria-pressed="false">Finished</button></div>
          <figcaption>Real screenshots. Same session. <strong>Anywhere you are.</strong></figcaption>
        </figure>
      </section>

      <section class="home-benefits wrap" id="use-cases" aria-labelledby="benefits-title">
        <p class="eyebrow">Less waiting around</p>
        <h2 id="benefits-title">Away from your desk.<br>Not out of the loop.</h2>
        <div class="benefit-grid">
          <article><div class="benefit-art art-progress" aria-hidden="true"><div class="mini-terminal"><div class="mini-dots"><i></i><i></i><i></i></div><span><b>✓</b> Reading files</span><span><b>✓</b> Making changes</span><span class="mini-active"><i></i> Running checks</span></div><span class="art-caption">Example workflow</span></div><h3>See what’s happening.</h3><p>Your terminal, live on your phone.</p></article>
          <article><div class="benefit-art art-reply" aria-hidden="true"><span class="mini-bubble">Shall I continue?</span><span class="mini-bubble reply">Yes, go ahead. <b>↗</b></span><span class="art-caption">Example interaction</span></div><h3>Keep things moving.</h3><p>A quick reply. Back to your day.</p></article>
          <article class="benefit-team"><div class="benefit-art art-team" aria-hidden="true"><div class="shared-demo"><div class="shared-demo-bar"><span>&gt;_ <b>Shared terminal</b></span><small>Illustration</small></div><div class="shared-demo-code"><span class="shared-demo-path">~/your-project</span><span><i>❯</i> Review this change with me.</span><span class="shared-demo-cursor"></span></div><div class="shared-demo-users"><span><i>Y</i> You <small>typing</small></span><span><i>T</i> Teammate <small>viewing</small></span></div></div></div><h3>Work in the same terminal.</h3><p>Invite a teammate to watch or type—with the link and password.</p></article>
        </div>
      </section>

      ${agentGrid()}

      <section class="home-start" id="start" aria-labelledby="start-title">
        <div class="wrap">
          <div class="section-intro" id="how"><p class="eyebrow">Computer → link → phone</p><h2 id="start-title">Three steps. You’re in.</h2><p>Install once on your computer. Open from any browser.</p></div>
          <p class="phone-setup-note" hidden>You’re on your phone. Run these steps on the computer where your agent lives. <a href="mailto:?subject=Set%20up%20shell.online&body=Open%20https%3A%2F%2Fshell.online%2F%23start%20on%20your%20computer%20to%20get%20started.">Email yourself the setup link</a></p>
          <ol class="setup-steps">
            <li><div class="step-title"><span>1</span><h3>Install shell.online</h3></div><p>Choose your computer. Then open its terminal and run:</p>
              ${platformPicker()}
              <div class="copy-command"><code id="install-command">curl -fsSL https://shell.online/install | sh</code><button type="button" data-copy="install" aria-label="Copy install command">Copy</button></div>
              <p class="step-note" id="platform-note">Prefer a package manager? <a href="/platforms/">Install with Homebrew</a>.</p>
              <details class="source-install"><summary>Build the CLI from source</summary><p>Have Git and Go 1.26.8 installed? Build the current release yourself. No Node.js or web build needed.</p><div class="copy-command"><pre><code id="source-build-command">${sourceBuildCommands(RELEASE_VERSION)}</code></pre><button type="button" data-copy="source_build" aria-label="Copy source build commands">Copy</button></div><p class="step-note" id="source-build-note">Use <code>./shell codex</code> from this folder, or put the binary on your PATH. <a href="/platforms/#section-4">Full source-build guide</a>.</p></details>
            </li>
            <li id="choose-agent"><div class="step-title"><span>2</span><h3>Start your agent with <code>shell</code></h3></div><p>Choose an agent you already have installed:</p>
              ${agentPicker()}
              <div class="copy-command"><code id="run-command">shell codex</code><button type="button" data-copy="run" aria-label="Copy start command">Copy</button></div>
              <p class="step-note">This starts a new shared session. It does not attach to a process that is already running.</p>
            </li>
            <li><div class="step-title"><span>3</span><h3>Open the link on your phone</h3></div><p>Your terminal prints a link, password and QR code. Scan the QR code, or open the link and enter the password.</p><div class="setup-result"><span aria-hidden="true">↗</span><strong>Same session. Now anywhere you can open a browser.</strong></div><p class="step-note">Keep your computer awake and connected to the internet.</p></li>
          </ol>
          <aside class="setup-love" aria-labelledby="setup-love-title"><div><strong id="setup-love-title">A little star goes a long way.</strong><p>Enjoying shell.online? Help more people find it.</p></div><a class="button secondary" href="https://github.com/TeoSlayer/shell.online" target="_blank" rel="noopener noreferrer" data-cta="github_star"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6-.9Z"/></svg>Star us on GitHub <span aria-hidden="true">↗</span></a></aside>
          <p class="copy-feedback" role="status" aria-live="polite"></p>
          <noscript><p>You can select and copy the commands above. Windows PowerShell: <code>irm https://shell.online/install.ps1 | iex</code>. Prefer Claude Code or OpenCode? Run <code>shell claude</code> or <code>shell opencode</code>.</p></noscript>
        </div>
      </section>

      <section class="home-team wrap" aria-labelledby="team-title"><div><p class="eyebrow">When one session becomes several</p><h2 id="team-title">All your sessions.<br>One place to open them.</h2><p>Create a free account to bring your linked computers and sessions into one web app. Share access with teammates when you choose.</p><a class="button secondary" href="https://app.shell.online/signup" data-cta="signup_team">Create a free account <span aria-hidden="true">↗</span></a><p class="step-note">Optional. You can try your first session without signing up.</p></div><div class="team-explainer"><p><span>01</span> Link your computer with <code>shell auth</code>.</p><p><span>02</span> Open your sessions from the web app.</p><p><span>03</span> Invite teammates when you want help.</p></div></section>

      <section class="home-specs wrap" id="specs" aria-labelledby="specs-title"><div class="section-intro"><p class="eyebrow">The details, when you want them</p><h2 id="specs-title">Simple to use. Clear about access.</h2></div>
        <dl class="spec-grid"><div><dt>Runs on your computer</dt><dd>shell.online shares your terminal. It does not move your work to a cloud computer.</dd></div><div><dt>Open in a browser</dt><dd>Use your phone, tablet or another computer. The viewing device needs no terminal app.</dd></div><div><dt>Encrypted by default</dt><dd>Terminal content is end-to-end encrypted. Keep the link and password private. <a href="/e2ee/">Read the security details</a>.</dd></div><div><dt>You choose who can type</dt><dd>Shared sessions allow input by default. Use <code>shell --read-only &lt;command&gt;</code> for view-only access.</dd></div><div><dt>Not just coding agents</dt><dd>Use <code>shell</code> with builds, tests, SSH and other terminal tools. <a href="/cli/">See command examples</a>.</dd></div><div><dt>Free, with source you can inspect</dt><dd>macOS, Windows and Linux, plus other supported systems. <a href="https://github.com/TeoSlayer/shell.online" target="_blank" rel="noreferrer">View the source</a> or <a href="/self-hosting/">host it yourself</a>.</dd></div></dl>
        <details><summary>Do I need an account or a paid plan?</summary><p>No account is needed for a basic shared terminal. The CLI is free and open source. An account adds the web app and team features. Your agent’s own model or subscription costs still apply.</p></details>
        <details><summary>Will it work if I close my laptop?</summary><p>Your computer must stay awake and online. If it sleeps or loses its connection, you cannot control it from your phone until it reconnects.</p></details>
        <details><summary>Can I use a session that is already running?</summary><p>Start the process through <code>shell</code> to share it. If your agent supports resuming a saved conversation, start its resume command through <code>shell</code>. shell.online does not attach to any arbitrary running process.</p></details>
        <details><summary>Can another agent connect through MCP?</summary><p>Yes, with a separate scoped grant. MCP access authorizes the server to decrypt terminal content for the agent. An ordinary browser link does not grant MCP access. <a href="https://github.com/TeoSlayer/shell.online/blob/main/docs/MCP.md">Read the MCP guide</a>.</p></details>
        <details><summary>Is this remote desktop?</summary><p>No. It shares the terminal process you started, not your whole desktop. You can watch its output and type into it. Other desktop apps are not shared.</p></details>
      </section>
      <section class="home-final wrap"><p class="eyebrow">Next time your agent is busy</p><h2>You don’t have to stay at your desk.</h2><a class="button" href="#start" data-cta="start_footer">Start your first session <span aria-hidden="true">↗</span></a><p>Free. No account needed to try it.</p></section>
    </main>
    <footer class="home-footer wrap"><a class="home-logo" href="/">shell<span>.</span>online</a><p>Developed by <a href="https://pilotprotocol.network/">Pilot Protocol</a>.</p><nav aria-label="Footer navigation"><a href="/docs/">Docs</a><a href="/security/">Security</a><a href="https://github.com/TeoSlayer/shell.online">GitHub</a><a href="https://app.shell.online/privacy">Privacy</a><a href="https://app.shell.online/terms">Terms</a><a href="/downloads/SHA256SUMS">v${RELEASE_VERSION} · SHA-256</a></nav></footer>
  </div>`;
}
