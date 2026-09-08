/**
 * Whether a machine can be said to be missing the tool a session kind runs.
 *
 * The agent on each linked machine looks for these on its PATH and reports
 * what it found, so this is the one place in the browser that turns that
 * report into a claim. It is a separate function because the claim is easy to
 * get subtly wrong and the modal that renders it cannot be tested here.
 */

/**
 * The kinds the agent looks for. The same ids appear in the CLI's detection
 * table and in the accounts service's accepted set; a kind outside this list,
 * such as a plain terminal process, is nothing the agent reports on.
 */
export const DETECTED_HARNESSES = new Set(["claude-code", "codex", "hermes", "openclaw"]);

export interface HarnessReport {
  /** What this machine's agent found. Absent until it has reported at all. */
  harnesses?: string[];
}

/**
 * True only when a machine has reported, and said this tool was not there.
 *
 * An absent report is unknown, not missing: a machine running an older build,
 * or one that has not polled since it was linked, has told us nothing, and
 * saying it lacks a tool on that basis would be inventing the answer. So the
 * three cases are answered separately rather than by the truthiness of a list.
 */
export function harnessMissing(kindId: string, device?: HarnessReport): boolean {
  if (!DETECTED_HARNESSES.has(kindId)) return false;
  if (!device || !Array.isArray(device.harnesses)) return false;
  return !device.harnesses.includes(kindId);
}
