/*
 * Vendored verbatim from shell.online: shared/host-presence.ts
 */
/*
 * What a viewer is told when the machine behind a session is not there.
 *
 * A viewer's own connection and the machine's connection are different things,
 * and conflating them is how a perfectly connected viewer ends up staring at an
 * empty terminal with nothing to explain it. The relay reports the machine's
 * state on every status message; this turns that into something to read.
 */

/** The relay's view of the machine hosting a session. */
export type HostPresence = "waiting" | "connected" | "disconnected" | "exited";

export interface HostNotice {
  /** A short headline, e.g. "Temporarily offline". */
  heading: string;
  /** One or two sentences saying what is being shown and what happens next. */
  body: string;
  /** True when the terminal below is a kept screen rather than a live one. */
  showingKeptScreen: boolean;
}

export interface HostNoticeInput {
  status: string | undefined;
  /** ISO timestamp of when the machine was last connected, if it ever was. */
  hostLastSeenAt?: string;
  /** ISO timestamp of the screen the viewer is looking at, if it is a kept one. */
  screenCapturedAt?: string;
  /** Whether anything at all has been drawn in the terminal. */
  hasScreen: boolean;
  now: number;
}

/** True while the machine is not connected and the session has not ended. */
export function hostIsAway(status: string | undefined): boolean {
  return status === "disconnected" || status === "waiting";
}

/*
 * "4 minutes ago" while that is the useful answer, a clock time once it is not.
 * Returns undefined for a timestamp that is missing or unreadable rather than
 * inventing a moment the viewer would then trust.
 */
export function describeSince(now: number, timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return undefined;
  const seconds = Math.max(0, Math.round((now - then) / 1_000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The notice to show, or null when the machine is there and nothing needs
 * saying.
 */
export function hostNotice(input: HostNoticeInput): HostNotice | null {
  if (!hostIsAway(input.status)) return null;

  if (input.status === "waiting") {
    return {
      heading: "Waiting for this machine",
      body: "This session has been created but its machine has not connected yet. " +
        "The terminal appears the moment it does.",
      showingKeptScreen: false,
    };
  }

  const lastSeen = describeSince(input.now, input.hostLastSeenAt);
  const seenSentence = lastSeen === undefined
    ? "The machine sharing this terminal is not connected right now."
    : `The machine sharing this terminal went offline ${lastSeen}.`;

  if (input.hasScreen) {
    const captured = describeSince(input.now, input.screenCapturedAt);
    return {
      heading: "Temporarily offline",
      body: `${seenSentence} You are looking at the last screen it sent` +
        `${captured === undefined ? "" : `, from ${captured}`}. ` +
        "It reconnects on its own, and the terminal goes live again when it does.",
      showingKeptScreen: true,
    };
  }

  return {
    heading: "Temporarily offline",
    body: `${seenSentence} Nothing is lost: the terminal comes back on its own ` +
      "once that machine is awake and online again.",
    showingKeptScreen: false,
  };
}
