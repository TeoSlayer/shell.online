// Names identify terminal tools, not endorsements or model integrations.
export const AGENT_BRANDS = [
  ["Claude Code", "claude.svg", "claude"],
  ["Codex", "codex.svg", "codex"],
  ["OpenCode", "opencode.svg", "opencode"],
  ["Muse Code", "meta.svg", "muse"],
  ["Gemini CLI", "gemini.svg", "gemini"],
  ["Cursor CLI", "cursor.svg", "cursor-agent"],
  ["Copilot CLI", "githubcopilot.svg", "copilot"],
  ["Cline CLI", "cline.svg", "cline"],
  ["Amp", "amp.svg", "amp"],
  ["Aider", "aider.svg", "aider"],
  ["Goose", "goose.svg", "goose session"],
  ["Kimi CLI", "kimi.svg", "kimi"],
  ["Qwen Code", "qwen.svg", "qwen"],
  ["Pi", "pi.svg", "pi"],
  ["Junie CLI", "junie.svg", "junie"],
  ["Kilo CLI", "kilocode.svg", "kilo"],
  ["Droid", "factory.svg", "droid"],
  ["Hermes", "hermes.png", "hermes"],
  ["OpenClaw", "openclaw.svg", "openclaw tui"],
] as const;

// Explicit launch commands, not names converted to lowercase. Some tools need
// a subcommand to open their terminal UI. The same catalog powers both grids.
export function agentCommand(id: string, custom = ""): string | null {
  if (id === "other") {
    const value = custom.trim();
    if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(custom))
      return null;
    return `shell ${value}`;
  }
  const agent = AGENT_BRANDS.find(
    ([, , command]) => command.split(" ")[0] === id,
  );
  return agent ? `shell ${agent[2]}` : null;
}

export function agentPicker(): string {
  const card = ([name, file, command]: (typeof AGENT_BRANDS)[number]) =>
    `<button type="button" data-agent="${command.split(" ")[0]}" aria-pressed="${command === "codex"}">${brandMark(name, file)}<code>shell ${command}</code></button>`;
  return `<div class="agent-picker" role="group" aria-label="Choose your agent">${AGENT_BRANDS.slice(0, 4).map(card).join("")}</div>
    <details class="agent-extras"><summary>More agents &amp; other terminal tools <span aria-hidden="true">+16</span></summary>
      <div class="agent-picker" role="group" aria-label="More agents">${AGENT_BRANDS.slice(4).map(card).join("")}<button type="button" data-agent="other" aria-pressed="false"><span class="brand-mark"><span class="terminal-mark" aria-hidden="true">&gt;_</span><span>Other terminal tool</span></span><code>shell &lt;command&gt;</code></button></div>
    </details>
    <div class="custom-agent" hidden><label for="custom-agent-command">The command you normally run</label><input id="custom-agent-command" type="text" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. npm run dev" aria-describedby="custom-agent-help"><p id="custom-agent-help" class="step-note">We add <code>shell</code> in front. Nothing runs in this page.</p></div>`;
}

// Keep this list in sync with the operating systems in release-targets.tsv.
export const PLATFORM_BRANDS = [
  ["macOS", "apple.svg", "macos"],
  ["Windows", "windows.svg", "windows"],
  ["Linux", "linux.svg", "linux"],
  ["FreeBSD", "freebsd.svg", "freebsd"],
  ["OpenBSD", "openbsd.svg", "openbsd"],
  ["NetBSD", "netbsd.svg", "netbsd"],
  ["DragonFly BSD", "dragonfly.svg", "dragonfly"],
  ["Solaris", "solaris.svg", "solaris"],
] as const;

export function brandMark(name: string, file: string, hero = false): string {
  return `<span class="brand-mark"><img src="/brands/${file}" width="28" height="28" alt="" ${hero ? "" : 'loading="lazy"'}><span>${name}</span></span>`;
}

export function agentGrid(): string {
  return `<section class="home-agents wrap" id="agents" aria-labelledby="agents-title">
    <p class="eyebrow">Bring the tools you already use</p>
    <h2 id="agents-title">Your agent. Your choice.</h2>
    <div class="agent-brand-grid">${AGENT_BRANDS.map(([name, file]) => brandMark(name, file)).join("")}<span class="brand-mark brand-other"><span class="terminal-mark" aria-hidden="true">&gt;_</span><span>Any terminal tool</span></span></div>
    <p class="brand-note">Share their terminal sessions, not their desktop apps. Your agent and model stay yours.</p>
  </section>`;
}

export function platformPicker(): string {
  return `<div class="platform-picker platform-brands" role="group" aria-label="Your computer’s operating system">${PLATFORM_BRANDS.map(([name, file, key]) => `<button type="button" data-platform="${key}" aria-pressed="${key === "macos"}">${brandMark(name, file)}</button>`).join("")}</div>`;
}
