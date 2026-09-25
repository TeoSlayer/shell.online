import type { Message } from "./transcript";

/**
 * The conversation an agent recorded, as it arrives from the host.
 *
 * This is the other half of internal/agentlog: the host follows the agent's
 * own record and sends it, and this reads it. Everything here treats the
 * payload as data from somebody else's machine -- every field is checked
 * before it is used, and anything unrecognised is dropped rather than drawn.
 * It arrives through the same encrypted channel as the terminal's output, so
 * it is exactly as trusted as the output already was: which is to say, shown
 * and never executed.
 */

/** What the record says a message is. */
export type RecordKind = "user" | "assistant" | "tool" | "choice";

/** A question the agent is waiting on, with the options it drew. */
export interface RecordChoice {
  question: string;
  header: string;
  options: string[];
}

export interface RecordEvent {
  kind: RecordKind;
  text: string;
  /** Epoch milliseconds, as the agent recorded it. */
  at: number;
  /** Position in the session, so a viewer can tell a repeat from a new one. */
  seq: number;
  choice?: RecordChoice;
}

export interface RecordBatch {
  /** Which adapter read it: "claude-code", "openclaw". */
  harness: string;
  events: RecordEvent[];
}

const KINDS: Record<string, RecordKind> = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  choice: "choice",
};

/** How much of one message is worth keeping; past this it is a file, not a line. */
const MAX_TEXT = 64 * 1024;

/** A menu longer than this is not a menu anybody drew. */
const MAX_OPTIONS = 12;

function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
}

function choiceOf(value: unknown): RecordChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const options = Array.isArray(raw.options)
    ? raw.options.filter((option): option is string => typeof option === "string" && option.trim() !== "")
    : [];
  const question = text(raw.question);
  if (question === "" || options.length === 0) return undefined;
  return { question, header: text(raw.header), options: options.slice(0, MAX_OPTIONS) };
}

/**
 * Reads a batch, or null.
 *
 * Null for anything that is not the shape this expects. A renderer that draws
 * whatever it is handed is a renderer that draws whatever anybody can get the
 * host to write, and the whole point of reading a record rather than a screen
 * is that the shape is known.
 */
export function readBatch(payload: Uint8Array): RecordBatch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.events)) return null;
  const events: RecordEvent[] = [];
  for (const entry of raw.events) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const kind = KINDS[String(record.kind)];
    if (!kind) continue;
    const said = text(record.text);
    const choice = choiceOf(record.choice);
    if (said === "" && !choice) continue;
    events.push({
      kind,
      text: said,
      at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : Date.now(),
      seq: typeof record.seq === "number" && Number.isFinite(record.seq) ? record.seq : 0,
      choice,
    });
  }
  if (events.length === 0) return null;
  return { harness: text(raw.harness) || "agent", events };
}

/**
 * The message a recorded event becomes.
 *
 * A record has roles, so nothing is inferred: what the person sent is `sent`,
 * what the agent said is `received`, a tool is a tool, and a question is a
 * message with its options attached.
 */
export function messageFor(event: RecordEvent): Omit<Message, "id" | "revision"> {
  const lines = event.text === "" ? [] : event.text.split("\n").map((line) => ({ text: line, runs: line ? [{ text: line }] : [] }));
  if (event.kind === "user") {
    return { kind: "sent", at: event.at, text: event.text, lines: [], open: false };
  }
  if (event.kind === "tool") {
    return { kind: "tool", at: event.at, text: event.text, lines: [], open: false };
  }
  if (event.kind === "choice" && event.choice) {
    return {
      kind: "received",
      at: event.at,
      text: "",
      lines: [{ text: event.choice.question, runs: [{ text: event.choice.question }] }],
      open: false,
      choice: event.choice,
    };
  }
  return { kind: "received", at: event.at, text: "", lines, open: false };
}
