import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CheckCircle } from "@phosphor-icons/react";
import { Button } from "./Button";

interface SignedInModalProps {
  onClose(): void;
}

/**
 * Confirms a terminal was linked, on the page that terminal's sessions land on.
 *
 * `shell login` used to end on a plain page served by the CLI itself, which
 * said the terminal was linked and then left the person on a dead end. The
 * callback now sends them here instead, so the sentence arrives on the page
 * the sessions will appear in.
 */
export function SignedInModal({ onClose }: SignedInModalProps) {
  const dismiss = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    /* Restoring the literal earlier value, not "", so a nested open is safe. */
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  /*
   * The only control gets focus, so the modal can be dismissed with a keypress
   * by someone who arrived here from a terminal and has not touched the mouse.
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => dismiss.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return createPortal(
    <div
      className="scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="sheet sheet-slim" role="dialog" aria-modal="true" aria-labelledby="signed-in-title">
        <div className="signed-in">
          <span className="signed-in-mark" aria-hidden="true">
            <CheckCircle size={26} weight="fill" />
          </span>
          <h2 id="signed-in-title">You are signed in.</h2>
          <p>
            This terminal is linked to your account. Sessions you start with{" "}
            <code>shell</code> appear here.
          </p>
          <Button ref={dismiss} type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
