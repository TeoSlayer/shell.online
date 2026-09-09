import { createPortal } from "react-dom";
import { Terminal as TerminalIcon, X } from "@phosphor-icons/react";
import { Button } from "./Button";
import { kindForCommand } from "../lib/session-kinds";
import type { SessionRecord } from "../lib/api";

/**
 * Offers the session that was just started.
 *
 * Starting one used to end in a line of text saying it would turn up, which
 * left the person who asked for it scanning a list for a row that was not
 * there yet. The machine has to poll, launch and publish first, so the wait is
 * real; what was missing was anything at the end of it.
 */
export function LaunchPrompt({
  session,
  onOpen,
  onClose,
}: {
  session: SessionRecord;
  onOpen(): void;
  onClose(): void;
}) {
  const kind = kindForCommand(session.command);
  return createPortal(
    <div
      className="scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="sheet is-compact" role="dialog" aria-modal="true" aria-label="Session started">
        <header className="sheet-head">
          <h2>Session started</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <X size={17} weight="bold" />
          </button>
        </header>

        <div className="sheet-body">
          <div className="launch-subject">
            <img src={kind.icon} alt="" className="launch-icon" />
            <span className="launch-text">
              <b>{session.name || session.command}</b>
              <em>{session.host ? `Running on ${session.host}` : "Running"}</em>
            </span>
          </div>

          <div className="sheet-actions">
            <Button type="button" variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button type="button" onClick={onOpen}>
              <TerminalIcon size={15} weight="bold" />
              Open the session
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
