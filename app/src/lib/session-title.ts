import type { SessionRecord } from "./api";

/**
 * A short display title for a session: the name somebody gave it, or a label
 * derived from the command it runs.
 *
 * A projection only. The stored name and command are never touched, and the
 * full command stays reachable wherever the title is shown in its place.
 */

/** The longest title shown as-is; longer ones are cut with an ellipsis. */
export const SESSION_TITLE_MAX = 48;

function cap(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= SESSION_TITLE_MAX) return trimmed;
  return `${trimmed.slice(0, SESSION_TITLE_MAX - 1)}…`;
}

/**
 * The executable a command runs, as a label.
 *
 * Parsed, not executed: nothing here runs the command or asks a shell about
 * it. The path is reduced to its file name, the rest of the line is dropped,
 * and what is left is capped so one odd command cannot widen a list.
 */
export function commandLabel(command: string): string {
  const line = command.trim();
  if (!line) return "Session";

  const first = firstToken(line);
  if (!first) return "Session";
  /* A line that starts with a flag has no executable to name. */
  if (first.startsWith("-")) return "Command";

  const label = basename(first).replace(/\.exe$/i, "");
  return cap(label || "Command");
}

/**
 * The first word of a command line. A quoted word is one token even when it
 * holds spaces, as in `"/opt/my bin/tool" --flag`.
 */
function firstToken(line: string): string {
  const quote = line.charAt(0);
  if (quote === '"' || quote === "'") {
    const end = line.indexOf(quote, 1);
    return end > 0 ? line.slice(1, end) : line.slice(1);
  }
  return line.split(/\s+/)[0] ?? "";
}

/**
 * The file name at the end of a path, for either separator. A token with no
 * separator is its own name, so `opencode` and `npm` pass through unchanged.
 */
function basename(token: string): string {
  const backslash = token.lastIndexOf("\\");
  const slash = token.lastIndexOf("/");
  const cut = Math.max(backslash, slash);
  return (cut >= 0 ? token.slice(cut + 1) : token).trim();
}

/**
 * What a page shows for a session: the operator's name when there is one,
 * else the label the command derives to.
 */
export function sessionTitle(session: Pick<SessionRecord, "name" | "command">): string {
  const name = (session.name ?? "").trim();
  return cap(name || commandLabel(session.command));
}

/**
 * A session's genuine summary, when the record carries one.
 *
 * There is no generated-briefing pipeline yet, so this is usually null. The
 * caller then shows a compact, truthful empty state instead of treating the
 * command as a summary -- the command is what runs, not what the session is.
 */
export function sessionSummary(session: Pick<SessionRecord, "description">): string | null {
  const value = (session.description ?? "").trim();
  return value ? value : null;
}
