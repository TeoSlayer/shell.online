import { useEffect, useId, useRef, useState, type FocusEvent, type HTMLAttributes, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionRecord } from "../lib/api";
import { ago } from "../lib/time";
import { summaryEligible } from "../lib/use-session-summaries";
import type { SessionSummary, SummarySource, SummaryState } from "../lib/session-summary-crypto";
import { useVault } from "../vault/VaultProvider";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;
/** Touch has no hover: a press held this long on the card opens the summary. */
const LONG_PRESS_MS = 500;
/** A finger that moves this far is scrolling, not pressing. */
const LONG_PRESS_SLOP_PX = 10;
const CARD_WIDTH = 360;
const VIEWPORT_MARGIN = 16;
const GAP = 6;

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

export interface CardPlacement {
  left: number;
  width: number;
  /** Exactly one of top/bottom is set: below the anchor, or above it. */
  top?: number;
  bottom?: number;
}

/**
 * Where the floating card goes for an anchor (a row or a board card): under
 * it, aligned to its left edge, kept inside the viewport, and flipped above
 * when there is not room below. Pure, so it is tested without a browser.
 */
export function placeSummaryCard(
  anchor: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  estimatedHeight = 220,
): CardPlacement {
  const width = Math.max(0, Math.min(CARD_WIDTH, viewport.width - 2 * VIEWPORT_MARGIN));
  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - width));
  const roomBelow = viewport.height - anchor.bottom - GAP - VIEWPORT_MARGIN;
  const roomAbove = anchor.top - GAP - VIEWPORT_MARGIN;
  if (roomBelow >= estimatedHeight || roomBelow >= roomAbove) return { left, width, top: anchor.bottom + GAP };
  return { left, width, bottom: viewport.height - anchor.top + GAP };
}

type HoverBindings = Pick<HTMLAttributes<HTMLElement>,
  "onPointerEnter" | "onPointerLeave" | "onPointerDown" | "onPointerUp" | "onPointerCancel" | "onPointerMove" |
  "onFocus" | "onBlur" | "onClickCapture" | "onContextMenu" | "aria-describedby"> & { "data-summary-hover"?: "" };

/*
 * A summary the owner can peek at without opening the session.
 *
 * The whole row (list) or card (board) is the target: hovering anywhere on it,
 * or focusing anything inside it, opens the summary after a short delay. On
 * touch, a long press anywhere on it does, and the tap that ends that press
 * does not open the session. The card floats in a portal so table and column
 * scrolling never clip it.
 *
 * It only ever shows what was already published and decrypted in this page;
 * opening it sends nothing and generates nothing. Every string is rendered as
 * React text: no Markdown, no links, no HTML.
 *
 * Children is a render function that receives the bindings to spread on the
 * row or card element: `{(hover) => <li {...hover}>…</li>}`.
 */
export function SessionSummaryHover({ session, summary, now, children }: {
  session: SessionRecord;
  summary: SessionSummary | undefined;
  now: number;
  children: (hover: HoverBindings) => ReactNode;
}) {
  const vault = useVault();
  const [placement, setPlacement] = useState<CardPlacement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const anchor = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const open = placement !== null;

  useEffect(() => () => {
    clearTimeout(timer.current);
    if (press.current) clearTimeout(press.current.timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setPlacement(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !card.current?.contains(target)) close();
    };
    // The card is fixed to where the anchor was; any scroll would leave it behind.
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!summaryEligible(session, vault.uid)) return <>{children({})}</>;

  const show = () => {
    const element = anchor.current;
    if (!element?.isConnected) return;
    const rect = element.getBoundingClientRect();
    setPlacement(placeSummaryCard(rect, { width: window.innerWidth, height: window.innerHeight }));
  };
  const schedule = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => (next ? show() : setPlacement(null)), delay);
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const bindings: HoverBindings = {
    "data-summary-hover": "",
    "aria-describedby": open ? cardId : undefined,
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") return;
      anchor.current = event.currentTarget;
      schedule(true, OPEN_DELAY_MS);
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse") schedule(false, CLOSE_DELAY_MS);
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse") return;
      anchor.current = event.currentTarget;
      cancelPress();
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press.current = null;
          suppressClick.current = true;
          clearTimeout(timer.current);
          show();
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const start = press.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      // The tap that ended a long press revealed the summary; it must not
      // also follow the link or open the session.
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      // A long press on touch raises the context menu; the summary replaces it.
      if (suppressClick.current || press.current) event.preventDefault();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      anchor.current = event.currentTarget;
      schedule(true, OPEN_DELAY_MS);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget as Node | null;
      if (!event.currentTarget.contains(next) && !card.current?.contains(next)) schedule(false, 0);
    },
  };

  return (
    <>
      {children(bindings)}
      {placement && createPortal(
        <div
          ref={card}
          className="summary-card"
          id={cardId}
          role="tooltip"
          style={{ left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom }}
          // Moving from the row onto the card keeps it open, so it can be read.
          onPointerEnter={(event) => { if (event.pointerType === "mouse") clearTimeout(timer.current); }}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") schedule(false, CLOSE_DELAY_MS); }}
        >
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
        </div>,
        document.body,
      )}
    </>
  );
}
