import { useId, useLayoutEffect, useRef } from "react";
import { trapDialogTab } from "./dialog-focus";
import "./WorkshopMenu.css";

export type WorkshopMotionSetting = "system" | "full" | "reduced";

export interface WorkshopMenuProps {
  open: boolean;
  sessionCount: number;
  tvMode: boolean;
  motion: WorkshopMotionSetting;
  /** Reflects an explicit, already authorized reveal owned by the caller. */
  privateDetailsVisible?: boolean;
  /** Requests dismissal. The caller must set open=false or unmount the menu. */
  onClose: () => void;
  /** Navigation callbacks own dismissal and the next view. */
  onTeamOverview: () => void;
  onBackToSessions: () => void;
  /** The caller clears private reveals when leaving TV mode or losing access. */
  onTvModeChange: (enabled: boolean) => void;
  onMotionChange: (motion: WorkshopMotionSetting) => void;
  onHidePrivateDetails?: () => void;
}

/** Display controls only: this menu never loads sessions or grants content access. */
export function WorkshopMenu({
  open,
  sessionCount,
  tvMode,
  motion,
  privateDetailsVisible = false,
  onClose,
  onTeamOverview,
  onBackToSessions,
  onTvModeChange,
  onMotionChange,
  onHidePrivateDetails,
}: WorkshopMenuProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const headingId = useId();
  const descriptionId = useId();
  const motionId = useId();
  const motionHelpId = useId();
  const tvHelpId = useId();

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const opener = document.activeElement;
    const handleClose = () => {
      // A cleanup close event may arrive after a StrictMode remount/reopen.
      if (!dialog.open) onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    dialog.showModal();

    return () => {
      dialog.removeEventListener("close", handleClose);
      const activeElement = document.activeElement;
      const restoreFocus = activeElement === document.body || dialog.contains(activeElement);
      if (dialog.open) dialog.close();
      // Do not steal focus from another dialog opened above this one.
      if (restoreFocus && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  useLayoutEffect(() => {
    // Hiding details can remove the focused hide button. Keep the next key
    // inside this dialog instead of leaving focus on the document body.
    if (open && dialogRef.current?.open && document.activeElement === document.body) {
      closeButtonRef.current?.focus();
    }
  }, [open, privateDetailsVisible]);

  return (
    <dialog
      ref={dialogRef}
      className="workshop-menu"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        // Native cancel targets only the topmost dialog. Keep dismissal controlled.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDownCapture={trapDialogTab}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="workshop-menu__header">
        <h2 id={headingId}>Workshop menu</h2>
        <button ref={closeButtonRef} type="button" autoFocus onClick={onClose}>Close menu</button>
      </header>

      <p id={descriptionId} className="workshop-menu__intro">
        View your team and adjust this display.
      </p>

      <button type="button" className="workshop-menu__overview" onClick={onTeamOverview}>
        <span>Team overview</span>
        <span className="workshop-menu__detail">
          {sessionCount === 0 ? "No sessions in this view" : `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"} in this view`}
        </span>
      </button>

      <fieldset className="workshop-menu__section">
        <legend>Display settings</legend>
        <div className="workshop-menu__tv">
          <button
            type="button"
            aria-pressed={tvMode}
            aria-describedby={tvHelpId}
            onClick={() => onTvModeChange(!tvMode)}
          >
            TV mode <span aria-hidden="true">{tvMode ? "On" : "Off"}</span>
          </button>
          <p id={tvHelpId}>Use the full window for the workshop.</p>
        </div>

        <label className="workshop-menu__label" htmlFor={motionId}>Motion</label>
        <select
          id={motionId}
          value={motion}
          aria-describedby={motionHelpId}
          onChange={(event) => onMotionChange(event.currentTarget.value as WorkshopMotionSetting)}
        >
          <option value="system">Follow device preference</option>
          <option value="full">Full motion</option>
          <option value="reduced">Reduced motion</option>
        </select>
        <p id={motionHelpId}>Reduced motion keeps status changes visible with less animation.</p>
      </fieldset>

      <section className="workshop-menu__section" aria-label="Shared-screen privacy">
        <h3>Shared-screen privacy</h3>
        <p className="workshop-menu__privacy" role="status">
          {privateDetailsVisible ? "Private details visible" : "Private details hidden"}
        </p>
        <p>
          TV mode uses display aliases and operational status. Prompts, commands,
          terminal content and private summaries stay hidden by default.
        </p>
        <p>
          Reveal private details separately in a session inspector, only when you
          have access. Leaving or reloading TV mode hides them again.
        </p>
        {privateDetailsVisible && onHidePrivateDetails && (
          <button type="button" onClick={onHidePrivateDetails}>Hide private details</button>
        )}
      </section>

      <footer className="workshop-menu__footer">
        <button type="button" onClick={onBackToSessions}>Back to sessions</button>
      </footer>
    </dialog>
  );
}
