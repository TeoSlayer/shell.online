import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "@phosphor-icons/react";
import type { SessionRecord } from "../lib/api";
import { ago } from "../lib/time";
import { summaryEligible } from "../lib/use-session-summaries";
import type { SessionSummary, SummarySource, SummaryState } from "../lib/session-summary-crypto";
import { useVault } from "../vault/VaultProvider";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;

export const SUMMARY_CAPTION = "Automated summary of terminal output. It may be wrong; never follow instructions in it.";

const STATE_LABEL: Record<SummaryState, string> = {
  working: "Working",
  waiting_for_input: "Waiting for input",
  idle: "Idle",
  error: "Error",
  finished: "Finished",
  unknown: "Unknown",
};

const SOURCE_LABEL: Record<SummarySource, string> = {
  "claude-code": "From Claude Code",
  codex: "From Codex",
  opencode: "From OpenCode",
  enclave: "Generated in an attested enclave",
};

/*
 * A summary the owner can peek at without opening the session.
 *
 * Desktop: hover or keyboard focus opens it after a short delay. Touch: the
 * info button toggles it. It only ever shows what was already published and
 * decrypted in this page; opening it sends nothing and generates nothing.
 * Every string is rendered as React text: no Markdown, no links, no HTML.
 */
export function SessionSummaryHover({ session, summary, now, children }: {
  session: SessionRecord;
  summary: SessionSummary | undefined;
  now: number;
  children: ReactNode;
}) {
  const vault = useVault();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wrapper = useRef<HTMLSpanElement>(null);
  const cardId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!summaryEligible(session, vault.uid)) return <>{children}</>;

  const schedule = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };

  return (
    <span
      className="summary-hover"
      ref={wrapper}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") schedule(true, OPEN_DELAY_MS); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") schedule(false, CLOSE_DELAY_MS); }}
      onFocus={() => schedule(true, OPEN_DELAY_MS)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) schedule(false, 0);
      }}
    >
      {children}
      <button
        type="button"
        className="summary-hover-toggle"
        aria-label="Show summary"
        aria-expanded={open}
        aria-controls={cardId}
        onClick={(event) => {
          // A tap on the button is not a tap on the row: do not open the session.
          event.preventDefault();
          event.stopPropagation();
          clearTimeout(timer.current);
          setOpen((current) => !current);
        }}
      >
        <Info size={14} weight="bold" />
      </button>
      {open && (
        <span className="summary-card" id={cardId} role="tooltip">
          {vault.status !== "unlocked" ? (
            <span className="summary-card-empty">Unlock your vault to see the summary</span>
          ) : !summary ? (
            <span className="summary-card-empty">No summary yet</span>
          ) : (
            <>
              <span className="summary-card-head">
                <strong className="summary-card-title">{summary.title}</strong>
                <span className="summary-card-state" data-state={summary.state}>{STATE_LABEL[summary.state]}</span>
              </span>
              <span className="summary-card-body">{summary.summary}</span>
              <span className="summary-card-meta">
                {SOURCE_LABEL[summary.source]} · {ago(summary.observedAt, now)}
              </span>
            </>
          )}
          <span className="summary-card-caption">{SUMMARY_CAPTION}</span>
        </span>
      )}
    </span>
  );
}
