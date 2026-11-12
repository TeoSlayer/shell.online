import { initAnalytics, trackPublicEvent } from "./analytics";
import { initXPixel } from "./x-pixel";
import { observeProductPage, setLandingVariant } from "./posthog";
import { agentCommand } from "./landing-brands";
import { loadPage, requestedPage, type StartPage } from "./start-pages";

const INSTALL = {
  unix: "curl -fsSL https://shell.online/install | sh",
  windows: "irm https://shell.online/install.ps1 | iex",
} as const;

/* The link a phone sends on. No ad source, so the laptop visit is not counted as a second ad click. */
const START_URL = "https://shell.online/start/";

function applyPage(page: StartPage): void {
  for (const [slot, text] of Object.entries(page)) {
    const element = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    // Text only: a page's wording is never markup.
    if (element && typeof text === "string") element.textContent = text;
  }
}

export async function initStart(): Promise<void> {
  // Decide which page this is before anything is counted, so the page view says.
  const key = requestedPage(new URL(window.location.href));
  const page = await loadPage(key);
  if (page) applyPage(page);
  setLandingVariant(page ? key : "default");
  document.documentElement.classList.add("start-ready");
  // The laptop opens the same page the phone saw.
  const SHARE_URL = page ? `${START_URL}?utm_content=${key}` : START_URL;

  initAnalytics();
  initXPixel();
  observeProductPage();

  const install = document.querySelector<HTMLElement>("#start-install");
  const run = document.querySelector<HTMLElement>("#start-run");
  const status = document.querySelector<HTMLElement>("#start-status");
  const say = (text: string) => {
    if (status) status.textContent = text;
  };

  const osButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-os]")];
  const setOs = (os: string) => {
    if (os !== "unix" && os !== "windows") return;
    if (install) install.textContent = INSTALL[os];
    osButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.os === os)));
  };
  setOs(/Windows/i.test(navigator.userAgent) ? "windows" : "unix");
  osButtons.forEach((b) => b.addEventListener("click", () => setOs(b.dataset.os ?? "")));

  // An example is also a choice: tapping one swaps it into step 2.
  const agentButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-agent]")];
  agentButtons.forEach((b) =>
    b.addEventListener("click", () => {
      const command = agentCommand(b.dataset.agent ?? "");
      if (!command || !run) return;
      run.textContent = command;
      agentButtons.forEach((other) => other.setAttribute("aria-pressed", String(other === b)));
    }),
  );

  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) =>
    button.addEventListener("click", () => {
      const target = button.dataset.copy === "run" ? "run" : "install";
      const text = (target === "run" ? run : install)?.textContent ?? "";
      trackPublicEvent("copy", target);
      navigator.clipboard?.writeText(text).then(
        () => {
          button.textContent = "Copied";
          window.setTimeout(() => (button.textContent = "Copy"), 1600);
        },
        () => say("Select the command and copy it."),
      );
    }),
  );

  document.querySelector<HTMLButtonElement>("#start-send")?.addEventListener("click", async () => {
    trackPublicEvent("cta_click", "start_share");
    const shareData = { title: "Set up shell.online", text: "Set up shell on my laptop:", url: SHARE_URL };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        if ((error as DOMException)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      say("Link copied. Paste it into a message or note to yourself.");
    } catch {
      say(`Open ${SHARE_URL.replace("https://", "")} on your laptop.`);
    }
  });
}

void initStart();
