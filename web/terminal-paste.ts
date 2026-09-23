/** Explicit clipboard entry for touch terminals. Drafts never leave this dialog
 * until Insert is pressed; the renderer owns bracketed-paste and input routing. */
export function mountTerminalPaste(options: {
  toolbar: HTMLElement;
  overlay: HTMLElement;
  canPaste: () => boolean;
  paste: (text: string) => void;
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "terminal-paste-button";
  button.textContent = "Paste";
  button.setAttribute("aria-label", "Paste into terminal");
  const dialog = document.createElement("dialog");
  dialog.className = "terminal-paste-dialog";
  dialog.setAttribute("aria-label", "Paste into terminal");
  dialog.innerHTML = `<form class="terminal-paste-form">
    <h2>Paste into terminal</h2>
    <p>Review before inserting. Line breaks can run commands.</p>
    <label>Text to paste<textarea rows="5" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
    <p class="terminal-paste-message" role="status"></p>
    <div class="terminal-paste-actions"><button type="button">Cancel</button><button type="submit">Insert into terminal</button></div>
  </form>`;
  const field = dialog.querySelector("textarea")!;
  const message = dialog.querySelector<HTMLElement>(".terminal-paste-message")!;
  const form = dialog.querySelector("form")!;
  const cancel = dialog.querySelector<HTMLButtonElement>('button[type="button"]')!;
  let generation = 0;
  let edits = 0;
  let disposed = false;
  const fit = () => {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? innerHeight;
    dialog.style.maxHeight = `${Math.max(0, height - 24)}px`;
    dialog.style.top = `${(viewport?.offsetTop ?? 0) + height / 2}px`;
  };
  window.visualViewport?.addEventListener("resize", fit);
  window.visualViewport?.addEventListener("scroll", fit);
  const clear = () => { generation++; field.value = ""; message.textContent = ""; };
  const close = () => { clear(); dialog.close(); };
  dialog.addEventListener("close", clear);
  dialog.addEventListener("cancel", clear);
  field.addEventListener("input", () => { edits++; });
  cancel.addEventListener("click", close);
  const open = () => {
    if (disposed || dialog.open) return;
    clear();
    fit();
    dialog.showModal();
    field.focus();
    if (!options.canPaste()) {
      message.textContent = "Connect and unlock a session with input access before pasting.";
      return;
    }
    message.textContent = "Touch and hold in the text box, then choose Paste.";
    const opened = generation;
    const initialEdits = edits;
    // Call during the user gesture (required by Safari), not after an await.
    try {
      const read = navigator.clipboard?.readText();
      void read?.then((text) => {
        if (disposed || !dialog.open || generation !== opened || edits !== initialEdits || !options.canPaste()) return;
        if (new TextEncoder().encode(text).byteLength > 12 * 1024) {
          message.textContent = "Clipboard is too large. Paste a smaller selection (up to 12 KB).";
          return;
        }
        field.value = text;
        if (text) message.textContent = "Ready to insert. Nothing has been sent yet.";
      }).catch(() => { /* Native paste into the visible text box remains available. */ });
    } catch { /* Clipboard APIs may be absent or denied by browser policy. */ }
  };
  button.addEventListener("click", open);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!options.canPaste()) {
      message.textContent = "Input is unavailable. Reconnect or ask for input access, then try again.";
      return;
    }
    if (!field.value) { field.focus(); return; }
    // Leave room for renderer framing inside the relay's 16 KiB input limit.
    if (new TextEncoder().encode(field.value).byteLength > 12 * 1024) {
      message.textContent = "Paste a smaller selection (up to 12 KB).";
      return;
    }
    options.paste(field.value);
    close();
  });
  options.toolbar.append(button);
  options.overlay.append(dialog);
  return { open, close, dispose() {
    disposed = true;
    close();
    window.visualViewport?.removeEventListener("resize", fit);
    window.visualViewport?.removeEventListener("scroll", fit);
    button.remove();
    dialog.remove();
  } };
}
