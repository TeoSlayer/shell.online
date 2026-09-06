/**
 * Optional account page.
 *
 * Accounts exist only to keep a list of shares you care about, plus the usual
 * settings for the account itself. Creating one is never required: every link
 * works exactly the same whether or not anyone signs in.
 */
import { completeShareUrl, forgetLinkFragment, linkFragmentFor } from "./link-fragments";

interface SavedLink {
  session_id: string;
  label: string;
  saved_at: number;
  status: string;
  share_url: string;
  encrypted?: boolean;
}

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(path, { credentials: "same-origin", ...init });

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * The share to return to. Resolved at click time rather than at render time,
 * so a tab left open before you opened a terminal still goes back correctly.
 *
 * The full URL lives in localStorage because it carries the #salt fragment,
 * which must never travel to the server as a query parameter.
 */
function lastTerminal(): string | null {
  try {
    const stored = localStorage.getItem("shell-online:last-terminal");
    if (stored && /\/s\/[A-Za-z0-9_-]{32}/.test(stored)) return stored;
  } catch {
    // Storage unavailable.
  }
  // Referrers drop the fragment, so this can only recover the session itself.
  const referrer = document.referrer;
  return referrer && /\/s\/[A-Za-z0-9_-]{32}/.test(referrer) ? referrer : null;
}

export function renderAccountPage(app: HTMLElement): void {
  const back = lastTerminal();
  app.innerHTML = `
    <div class="account-shell">
      <header class="account-topbar">
        <a class="wordmark" href="/"><span>shell</span><i>.</i>online</a>
        <div class="account-topbar-right">
          <span id="account-whoami" class="account-whoami" hidden></span>
          <button id="account-settings-open" class="btn btn-small" type="button" hidden>Settings</button>
          <a id="account-exit" class="account-exit" href="${esc(back ?? "/")}">${back ? "Back to terminal" : "Close"}</a>
        </div>
      </header>
      <main id="account-body" class="account-main"><p class="account-muted">Loading…</p></main>
    </div>`;
  const exit = app.querySelector<HTMLAnchorElement>("#account-exit")!;
  exit.addEventListener("click", (event) => {
    const destination = lastTerminal();
    if (!destination) return;
    event.preventDefault();
    window.location.href = destination;
  });

  void refresh(app.querySelector<HTMLElement>("#account-body")!);
}

async function refresh(body: HTMLElement): Promise<void> {
  let me: { signedIn?: boolean; email?: string } = {};
  try {
    const response = await api("/api/account/me");
    if (response.status === 503) {
      body.innerHTML = `<div class="account-card"><p class="account-muted">This relay does not have accounts enabled. Shares work normally without one.</p></div>`;
      return;
    }
    me = await response.json();
  } catch {
    body.innerHTML = `<div class="account-card"><p class="account-muted">Could not reach the relay.</p></div>`;
    return;
  }
  if (me.signedIn && me.email) void renderSignedIn(body, me.email);
  else renderSignedOut(body);
}

function renderSignedOut(body: HTMLElement): void {
  body.innerHTML = `
    <section class="account-hero">
      <h1>Your links, kept in one place.</h1>
      <p>An account is entirely optional. It only remembers the shares you save, so you can find
         them again later. Everything about shell.online works without one.</p>
    </section>
    <form id="account-form" class="account-card account-form" novalidate>
      <div class="account-field">
        <label for="account-email">Email</label>
        <input id="account-email" type="email" autocomplete="username" required placeholder="you@example.com" />
      </div>
      <div class="account-field">
        <label for="account-password">Password</label>
        <input id="account-password" type="password" autocomplete="current-password" minlength="8" required placeholder="At least 8 characters" />
      </div>
      <div class="account-row">
        <button type="submit" class="btn btn-primary">Sign in</button>
        <button id="account-create" type="button" class="btn">Create account</button>
      </div>
      <p id="account-error" class="account-error" hidden></p>
    </form>`;
  const form = body.querySelector<HTMLFormElement>("#account-form")!;
  const error = body.querySelector<HTMLElement>("#account-error")!;
  const submit = async (path: string): Promise<void> => {
    error.hidden = true;
    const email = form.querySelector<HTMLInputElement>("#account-email")!.value;
    const password = form.querySelector<HTMLInputElement>("#account-password")!.value;
    try {
      const response = await api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (response.ok) { void refresh(body); return; }
      error.textContent = ((await response.json()) as { error?: string }).error ?? "Something went wrong.";
      error.hidden = false;
    } catch {
      error.textContent = "Could not reach the relay.";
      error.hidden = false;
    }
  };
  form.addEventListener("submit", (event) => { event.preventDefault(); void submit("/api/account/login"); });
  body.querySelector<HTMLButtonElement>("#account-create")!
    .addEventListener("click", () => { void submit("/api/account/register"); });
}

async function renderSignedIn(body: HTMLElement, email: string): Promise<void> {
  const whoami = document.querySelector<HTMLElement>("#account-whoami");
  if (whoami) {
    whoami.hidden = false;
    whoami.innerHTML = `<strong id="account-current-email">${esc(email)}</strong>`;
  }

  body.innerHTML = `
    <section class="account-section">
      <div class="account-section-head">
        <h1 class="account-h1">My terminal links</h1>
        <button id="account-refresh" type="button" class="btn btn-small">Refresh</button>
      </div>
      <div id="account-links" class="account-links"><p class="account-muted">Loading…</p></div>
    </section>

    <div id="account-sheet" class="account-sheet" hidden>
      <div class="account-sheet-panel" role="dialog" aria-label="Account settings">
        <div class="account-sheet-head">
          <h2>Settings</h2>
          <button id="account-sheet-close" type="button" class="btn btn-small">Done</button>
        </div>
        <p class="account-muted">Signed in as <strong>${esc(email)}</strong></p>

        <form id="form-email" class="account-form">
          <div class="account-field">
            <label for="new-email">Change email</label>
            <input id="new-email" type="email" autocomplete="email" placeholder="${esc(email)}" required />
          </div>
          <div class="account-row"><button type="submit" class="btn">Update email</button>
            <span class="account-inline-msg" data-msg="email"></span></div>
        </form>

        <form id="form-password" class="account-form">
          <div class="account-field">
            <label for="cur-password">Current password</label>
            <input id="cur-password" type="password" autocomplete="current-password" required />
          </div>
          <div class="account-field">
            <label for="new-password">New password</label>
            <input id="new-password" type="password" autocomplete="new-password" minlength="8" required />
          </div>
          <div class="account-row"><button type="submit" class="btn">Update password</button>
            <span class="account-inline-msg" data-msg="password"></span></div>
        </form>

        <div class="account-sheet-divider"></div>

        <div class="account-row">
          <button id="account-signout" type="button" class="btn">Sign out</button>
        </div>

        <form id="form-delete" class="account-danger">
          <p class="account-muted">Deleting your account removes this list. Any share that is running
             keeps running — accounts never control sessions.</p>
          <div class="account-field">
            <label for="del-password">Confirm with your password</label>
            <input id="del-password" type="password" autocomplete="current-password" required />
          </div>
          <div class="account-row"><button type="submit" class="btn btn-danger">Delete account</button>
            <span class="account-inline-msg" data-msg="delete"></span></div>
        </form>
      </div>
    </div>`;

  const msg = (name: string, text: string, bad = false): void => {
    const el = body.querySelector<HTMLElement>(`[data-msg="${name}"]`)!;
    el.textContent = text;
    el.classList.toggle("is-bad", bad);
  };

  const sheet = body.querySelector<HTMLElement>("#account-sheet")!;
  const settingsButton = document.querySelector<HTMLButtonElement>("#account-settings-open");
  if (settingsButton) {
    settingsButton.hidden = false;
    settingsButton.onclick = () => { sheet.hidden = false; };
  }
  body.querySelector<HTMLButtonElement>("#account-sheet-close")!
    .addEventListener("click", () => { sheet.hidden = true; });
  sheet.addEventListener("click", (event) => { if (event.target === sheet) sheet.hidden = true; });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") sheet.hidden = true; });

  body.querySelector<HTMLButtonElement>("#account-signout")!.addEventListener("click", () => {
    void api("/api/account/logout", { method: "POST" }).then(() => refresh(body));
  });
  body.querySelector<HTMLButtonElement>("#account-refresh")!.addEventListener("click", () => {
    void loadLinks(body);
  });

  body.querySelector<HTMLFormElement>("#form-email")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = body.querySelector<HTMLInputElement>("#new-email")!.value;
    void api("/api/account/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: value }),
    }).then(async (r) => {
      const data = await r.json() as { error?: string; email?: string };
      if (r.ok) { msg("email", "Updated"); document.querySelector("#account-current-email")!.textContent = data.email ?? value; }
      else msg("email", data.error ?? "Could not update", true);
    });
  });

  body.querySelector<HTMLFormElement>("#form-password")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const current = body.querySelector<HTMLInputElement>("#cur-password")!.value;
    const next = body.querySelector<HTMLInputElement>("#new-password")!.value;
    void api("/api/account/password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, next }),
    }).then(async (r) => {
      if (r.ok) { msg("password", "Updated"); (body.querySelector<HTMLFormElement>("#form-password")!).reset(); }
      else msg("password", ((await r.json()) as { error?: string }).error ?? "Could not update", true);
    });
  });

  body.querySelector<HTMLFormElement>("#form-delete")!.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!window.confirm("Delete this account and its saved list? Running shares are unaffected.")) return;
    const password = body.querySelector<HTMLInputElement>("#del-password")!.value;
    void api("/api/account/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(async (r) => {
      if (r.ok) void refresh(body);
      else msg("delete", ((await r.json()) as { error?: string }).error ?? "Could not delete", true);
    });
  });

  void loadLinks(body);
}

async function loadLinks(body: HTMLElement): Promise<void> {
  const list = body.querySelector<HTMLElement>("#account-links");
  if (!list) return;
  try {
    const response = await api("/api/account/links");
    const links = ((await response.json()) as { links?: SavedLink[] }).links ?? [];
    if (links.length === 0) {
      list.innerHTML = `<div class="account-card"><p class="account-muted">No links saved yet. Open any share and use <em>Save link</em> in its header, or type <code>/login</code> then <code>/save</code> in the terminal.</p></div>`;
      return;
    }
    list.innerHTML = links.map((link) => {
      const full = completeShareUrl(link.share_url, link.session_id);
      // An encrypted share keeps its key in the fragment, which never reaches
      // the relay. If this browser did not save the link, it cannot rebuild it.
      const keyMissing = link.encrypted === true && !linkFragmentFor(link.session_id);
      return `
      <article class="account-link ${link.status === "connected" ? "is-live" : "is-dead"}">
        <div class="account-link-top">
          <span class="account-pill">${statusLabel(link.status)}</span>
          <span class="account-link-label">${esc(link.label || link.session_id.slice(0, 10))}</span>
          <span class="account-link-age">${age(link.saved_at)}</span>
        </div>
        <code class="account-link-url">${esc(keyMissing ? link.share_url : full)}</code>
        ${keyMissing ? `<p class="account-key-note">Saved on another device. The decryption key stays in
           the browser that saved it and never reaches the relay, so open this share from that device
           or paste the full link, password included.</p>` : ""}
        <div class="account-row">
          ${keyMissing ? "" : `<button class="btn btn-small" data-copy="${esc(full)}">Copy</button>
          <a class="btn btn-small" href="${esc(full)}" target="_blank" rel="noreferrer">Open</a>`}
          <button class="btn btn-small" data-remove="${esc(link.session_id)}">Remove</button>
        </div>
      </article>`;
    }).join("");
    list.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
      button.addEventListener("click", () => {
        void navigator.clipboard?.writeText(button.dataset.copy ?? "");
        const original = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => { button.textContent = original; }, 1200);
      });
    });
    list.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        void api("/api/account/links", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: button.dataset.remove }),
        }).then(() => { forgetLinkFragment(button.dataset.remove ?? ""); void loadLinks(body); });
      });
    });
  } catch {
    list.innerHTML = `<div class="account-card"><p class="account-muted">Could not load your links.</p></div>`;
  }
}

function statusLabel(status: string): string {
  if (status === "connected") return "Live";
  if (status === "disconnected") return "Reconnecting";
  if (status === "ended") return "Ended";
  return "Unknown";
}

function age(savedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - savedAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
