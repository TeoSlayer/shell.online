export type Appearance = "system" | "light" | "dark";
const KEY = "shell-online-app-theme";
const EVENT = "shell-appearance-change";
let preference: Appearance = "system";

export function parseAppearance(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

export function getAppearance(): Appearance { return preference; }

function applyAppearance() {
  if (preference === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  // Both media-qualified tags must describe the explicit override, too.
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    meta.setAttribute("content", dark ? "#161914" : "#f3f1e9");
  });
}

export function setAppearance(value: Appearance) {
  preference = parseAppearance(value);
  try {
    if (preference === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch { /* A display preference works even when storage is unavailable. */ }
  applyAppearance();
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeAppearance(listener: () => void) {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** Run before mounting React, including on auth pages. Stores no account data. */
export function initializeAppearance() {
  try { preference = parseAppearance(localStorage.getItem(KEY)); }
  catch { preference = "system"; }
  applyAppearance();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => { if (preference === "system") applyAppearance(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    preference = parseAppearance(event.newValue);
    applyAppearance();
    window.dispatchEvent(new Event(EVENT));
  };
  media.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
  };
}
