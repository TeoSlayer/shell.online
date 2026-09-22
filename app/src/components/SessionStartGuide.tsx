import { useState } from "react";
import { useCopy, COPY_FAILED } from "../lib/clipboard";

/** The same path works without authorizing remote process creation. */
export function SessionStartGuide() {
  const [windows, setWindows] = useState(false);
  const { copy, copiedKey, failedKey } = useCopy<string>();
  const install = windows ? "irm https://shell.online/install.ps1 | iex" : "curl -fsSL https://shell.online/install | sh";
  function command(text: string, key: string) {
    return <div className="start-command"><code>{text}</code><button type="button" onClick={() => void copy(text, key)} aria-label={`Copy ${text}`}>{copiedKey === key ? "Copied" : "Copy"}</button></div>;
  }
  return <section className="session-start-guide" aria-label="Start your first session">
    <h2>Your terminal. Here, too.</h2>
    <p>Run these on the computer where your agent or command will work—not on your phone.</p>
    <ol>
      <li><strong>Install shell</strong>
        <div className="start-platforms" role="group" aria-label="Computer operating system">
          <button type="button" aria-pressed={!windows} onClick={() => setWindows(false)}>macOS / Linux</button>
          <button type="button" aria-pressed={windows} onClick={() => setWindows(true)}>Windows PowerShell</button>
        </div>
        {command(install, "install")}
      </li>
      <li><strong>Link this computer to your account</strong>{command("shell auth", "auth")}<p>Finish sign-in in the browser that opens.</p></li>
      <li><strong>Start an agent or command</strong>{command("shell codex", "start")}<p>Replace <code>codex</code> with <code>claude</code>, <code>opencode</code>, or a command you already use. The session appears here automatically.</p></li>
    </ol>
    <p>Already linked a computer with remote start allowed? Choose <b>+ Session</b> above instead. Keep that computer awake and online.</p>
    {failedKey && <p role="status">{COPY_FAILED}</p>}
    <a href="https://shell.online/docs/" target="_blank" rel="noopener noreferrer">Read the quick start</a>
  </section>;
}
