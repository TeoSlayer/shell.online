import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CheckCircle, X } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import {
  APP_VERSION,
  FEEDBACK_KINDS,
  MAX_FEEDBACK,
  describeBrowser,
  surfaceLabel,
  trimContext,
  type FeedbackKind,
  type FeedbackPayload,
} from "../lib/feedback";
import type { FeedbackRequest } from "./context";

export interface FeedbackSheetProps {
  /** Whose message it is, shown next to the reply choice so nothing is implied. */
  email: string;
  /** The route it is sent from, path only. */
  route: string;
  request: FeedbackRequest;
  /** Defaults to this browser's. A parameter so the sheet can be rendered elsewhere. */
  userAgent?: string;
  onSend(payload: FeedbackPayload, anonymous?: boolean): Promise<unknown>;
  onClose(): void;
}

/**
 * The form itself: a kind, a message, what travels with it, and whether a
 * reply is welcome.
 *
 * Everything sent is on the screen. The "sent with your message" list is the
 * actual context, not a summary of it, so nobody has to wonder what the app
 * attached on their behalf. Nothing from a terminal is ever in it: the app
 * never has the plaintext, and the line under the list says so.
 */
export function FeedbackSheet({
  email,
  route,
  request,
  userAgent = navigator.userAgent,
  onSend,
  onClose,
}: FeedbackSheetProps) {
  const [kind, setKind] = useState<FeedbackKind>(request.kind ?? "problem");
  const [text, setText] = useState("");
  const [canReply, setCanReply] = useState(true);
  const [anonymous, setAnonymous] = useState(!email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const context = anonymous ? {} : trimContext(request.context);
  const option = FEEDBACK_KINDS.find((candidate) => candidate.id === kind) ?? FEEDBACK_KINDS[0];

  useEffect(() => {
    /*
     * Capture phase, so Escape closes this sheet and stops there. It opens on
     * top of other dialogs, which listen for the same key on the document,
     * and one press must not close the form underneath as well.
     */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    /* Restoring the literal earlier value, not "", so a nested open is safe. */
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  /* The box first, then the one button left once the message has gone. */
  useEffect(() => {
    const frame = requestAnimationFrame(() => (sent ? done.current : box.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [sent]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSend({
        kind,
        body,
        surface: request.surface,
        route,
        app_version: APP_VERSION,
        can_reply: !anonymous && canReply,
        context,
      }, anonymous);
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="scrim feedback-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="sheet sheet-slim feedback-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
      >
        {sent ? (
          <div className="signed-in feedback-sent">
            <span className="signed-in-mark" aria-hidden="true">
              <CheckCircle size={26} weight="fill" />
            </span>
            <h2 id="feedback-title">Sent. Thank you.</h2>
            <p>
              {anonymous ? "We received your anonymous report. No account or email was attached, so we cannot reply." : canReply ? (
                <>
                  If we have a question, we will write to <b>{email}</b>.
                </>
              ) : (
                "We will read it and, as you asked, not write back."
              )}
            </p>
            <Button ref={done} type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <>
            <header className="sheet-head">
              <h2 id="feedback-title">Tell us</h2>
              <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
                <X size={17} weight="bold" />
              </button>
            </header>

            <form className="sheet-body feedback-form" onSubmit={handleSubmit}>
              {request.prompt && <p className="feedback-prompt">{request.prompt}</p>}

              <div className="feedback-kinds" role="radiogroup" aria-label="What kind of message">
                {FEEDBACK_KINDS.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked={candidate.id === kind}
                    className="feedback-kind"
                    onClick={() => setKind(candidate.id)}
                  >
                    {candidate.label}
                  </button>
                ))}
              </div>

              <div className="sheet-field">
                <label htmlFor="feedback-text">{option.label}</label>
                <textarea
                  id="feedback-text"
                  ref={box}
                  className="feedback-text"
                  rows={5}
                  maxLength={MAX_FEEDBACK}
                  value={text}
                  placeholder={option.placeholder}
                  onChange={(event) => setText(event.target.value)}
                  disabled={busy}
                />
              </div>

              {error && <Alert tone="error">{error}</Alert>}

              <dl className="feedback-attached" aria-label="Sent with your message">
                <div>
                  <dt>From</dt>
                  <dd>
                    {surfaceLabel(request.surface)}, <code>{route}</code>
                  </dd>
                </div>
                <div>
                  <dt>App</dt>
                  <dd>
                    {APP_VERSION} · {describeBrowser(userAgent)}
                  </dd>
                </div>
                {Object.entries(context).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replace(/_/g, " ")}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="sheet-help feedback-privacy">
                Nothing from your terminals, no share links and no passwords are
                attached. Please do not paste them either.
              </p>

              {email && <label className="feedback-anonymous feedback-reply">
                <input type="checkbox" checked={anonymous} disabled={busy}
                  onChange={(event) => setAnonymous(event.target.checked)} />
                <span>Send without my account or email</span>
              </label>}
              {anonymous ? <p className="sheet-help">No account or email will be attached. We cannot reply to anonymous reports.</p> : <label className="feedback-reply feedback-contact">
                <input
                  type="checkbox"
                  checked={canReply}
                  onChange={(event) => setCanReply(event.target.checked)}
                />
                <span>
                  You can write back to me at <b>{email}</b>
                </span>
              </label>}

              <div className="sheet-actions">
                <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" busy={busy} busyLabel="Sending" disabled={busy || !text.trim()}>
                  Send
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
