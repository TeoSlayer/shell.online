import { initAnalytics, trackPublicEvent } from "./analytics";
import { observeProductPage } from "./posthog";
import "./home.css";
import { agentCommand, PLATFORM_BRANDS } from "./landing-brands";
import { RELEASE_VERSION } from "../shared/release";
import { sourceBuildCommands } from "../shared/source-build";

const commands = {
  unix: "curl -fsSL https://shell.online/install | sh",
  windows: "irm https://shell.online/install.ps1 | iex",
} as const;

export function initLanding(): void {
  document.documentElement.classList.add("home-root");
  initAnalytics();
  observeProductPage();
  const proofs = document.querySelectorAll<HTMLButtonElement>("[data-proof]");
  proofs.forEach((button) =>
    button.addEventListener("click", () => {
      const done = button.dataset.proof === "complete";
      const picture = document.querySelector<HTMLImageElement>("#proof-image");
      if (!picture) return;
      const frame = document.querySelector<HTMLElement>(".proof-window");
      picture.onload = () => {
        if (frame) frame.scrollTop = done ? frame.scrollHeight : 0;
      };
      picture.src = done
        ? "/screenshots/codex-complete-mobile.png"
        : "/screenshots/codex-working-mobile.png";
      picture.alt = done
        ? "The same real Codex session showing its completed fix and tests."
        : "A real Codex session investigating a failing test.";
      proofs.forEach((other) =>
        other.setAttribute("aria-pressed", String(other === button)),
      );
    }),
  );
  const feedback = document.querySelector<HTMLElement>(".copy-feedback");
  const install = document.querySelector<HTMLElement>("#install-command");
  const run = document.querySelector<HTMLElement>("#run-command");
  const sourceBuild = document.querySelector<HTMLElement>(
    "#source-build-command",
  );
  const platformButtons = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-platform]"),
  ];
  const setPlatform = (platform: string) => {
    if (!PLATFORM_BRANDS.some(([, , key]) => key === platform)) return;
    if (sourceBuild)
      sourceBuild.textContent = sourceBuildCommands(
        RELEASE_VERSION,
        platform === "windows",
      );
    const sourceNote =
      document.querySelector<HTMLElement>("#source-build-note");
    if (sourceNote)
      sourceNote.innerHTML =
        platform === "windows"
          ? 'Use <code>.\\shell.exe codex</code> in PowerShell from this folder, or put the binary on your PATH. <a href="/platforms/#section-4">Full source-build guide</a>.'
          : 'Use <code>./shell codex</code> from this folder, or put the binary on your PATH. <a href="/platforms/#section-4">Full source-build guide</a>.';
    if (install)
      install.textContent =
        commands[platform === "windows" ? "windows" : "unix"];
    platformButtons.forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.platform === platform)),
    );
    const note = document.querySelector<HTMLElement>("#platform-note");
    if (note && platform === "windows")
      note.innerHTML =
        'Run in PowerShell. <a href="/platforms/">Other install methods</a>.';
    else if (note)
      note.innerHTML =
        'Prefer a package manager? <a href="/platforms/">Install with Homebrew</a>.';
  };
  setPlatform(
    /Windows/i.test(navigator.userAgent)
      ? "windows"
      : /Linux|X11/i.test(navigator.userAgent) &&
          !/Android/i.test(navigator.userAgent)
        ? "linux"
        : "macos",
  );
  platformButtons.forEach((b) =>
    b.addEventListener("click", () => setPlatform(b.dataset.platform ?? "")),
  );
  const agentButtons = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-agent]"),
  ];
  const customAgent = document.querySelector<HTMLInputElement>(
    "#custom-agent-command",
  );
  const customField = document.querySelector<HTMLElement>(".custom-agent");
  const runCopy =
    document.querySelector<HTMLButtonElement>('[data-copy="run"]');
  let selectedAgent = "codex";
  const updateRun = () => {
    const command = agentCommand(selectedAgent, customAgent?.value);
    if (run) run.textContent = command ?? "shell <command>";
    if (runCopy) runCopy.disabled = command === null;
  };
  agentButtons.forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.agent ?? "";
      if (id !== "other" && agentCommand(id) === null) return;
      selectedAgent = id;
      if (customField) customField.hidden = id !== "other";
      updateRun();
      if (id === "other") customAgent?.focus({ preventScroll: true });
      agentButtons.forEach((other) =>
        other.setAttribute("aria-pressed", String(other === b)),
      );
    }),
  );
  customAgent?.addEventListener("input", updateRun);
  if (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  ) {
    document
      .querySelector<HTMLElement>(".phone-setup-note")
      ?.removeAttribute("hidden");
  }
  document
    .querySelectorAll<HTMLButtonElement>("[data-copy]")
    .forEach((button) => {
      let serial = 0;
      button.addEventListener("click", async () => {
        const current = ++serial;
        const target = button.dataset.copy;
        if (
          target !== "install" &&
          target !== "run" &&
          target !== "source_build"
        )
          return;
        if (
          target === "run" &&
          agentCommand(selectedAgent, customAgent?.value) === null
        )
          return;
        const value = (
          target === "install"
            ? install
            : target === "source_build"
              ? sourceBuild
              : run
        )?.textContent;
        if (!value) return;
        try {
          if (!navigator.clipboard?.writeText)
            throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(value);
          if (serial !== current) return;
          button.textContent = "Copied";
          if (feedback)
            feedback.textContent =
              target === "install"
                ? "Copied. Paste it into a terminal on your computer."
                : target === "source_build"
                  ? "Copied. Run these commands where you want the new source checkout."
                  : "Copied. Run it on your computer, then open the link on your phone.";
          trackPublicEvent("copy", target);
        } catch {
          if (serial !== current) return;
          if (feedback)
            feedback.textContent =
              "Could not copy automatically. Select the command above and copy it.";
        }
        setTimeout(() => {
          if (serial === current) button.textContent = "Copy";
        }, 2000);
      });
    });
  document.querySelectorAll<HTMLElement>("[data-cta]").forEach((link) => {
    link.addEventListener("click", () =>
      trackPublicEvent("cta_click", link.dataset.cta ?? ""),
    );
  });
}
