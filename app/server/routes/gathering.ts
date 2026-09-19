import type { Device, GameCollectionRun } from "../lib/types";

/**
 * The gathering: what a machine is allowed to report, and what it costs.
 *
 * This is the one part of the game that reads real work and spends real money,
 * so it is the one part written defensively.
 *
 * Sessions are end-to-end encrypted. The service derives no key and holds no
 * password, so it cannot read terminal output and never will. Anything richer
 * than counting rows -- pull requests opened, lines changed, tokens spent --
 * exists only where the plaintext already is, which is the operator's own
 * machine. So the agent gathers it there and sends numbers.
 *
 * Numbers, and nothing else. There is no field here for a branch name, a commit
 * message, a file path, a diff or a line of output, and that is deliberate
 * rather than incidental: a shape that cannot carry those cannot leak them by
 * somebody later deciding it would be convenient. If that ever has to change,
 * it should be hard, and it should be argued about here.
 */

/**
 * A cap on any single figure, so one bad report cannot make the vial absurd.
 *
 * Ten billion, not a hundred million. A real machine reported eighty-three
 * million tokens for three days of ordinary work the first time this was run
 * against one, which is most of the way to the tighter cap -- and a cap that
 * clips honest reports is worse than no cap at all, because the number it
 * produces is wrong and looks reasonable. This one exists to stop nonsense, not
 * to bound real use.
 */
const MOST = 10_000_000_000;

/** What a run may say, before any of it is believed. */
export interface ReportedRun {
  tokens: number;
  pullRequests: number;
  commits: number;
  insertions: number;
  deletions: number;
  error: string;
}

function count(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(MOST, Math.max(0, Math.floor(numeric)));
}

/**
 * Reads a report from a machine.
 *
 * Everything is narrowed on the way in. An agent is a program on somebody's
 * laptop, and a laptop is not a place this service gets to trust arithmetic
 * from: a negative token count would run the total backwards, and one absurd
 * figure would make the vial meaningless for good, because these are summed
 * and never recomputed.
 */
export function readRun(body: Record<string, unknown>): ReportedRun {
  return {
    tokens: count(body.tokens),
    pullRequests: count(body.pull_requests),
    commits: count(body.commits),
    insertions: count(body.insertions),
    deletions: count(body.deletions),
    /* A failure is a sentence for a person to read, not a payload. */
    error: typeof body.error === "string" ? body.error.slice(0, 200) : "",
  };
}

export function runFrom(
  id: string,
  uid: string,
  device: { id: string; label: string },
  reported: ReportedRun,
  now: number,
): GameCollectionRun {
  return {
    id,
    uid,
    deviceId: device.id,
    deviceName: device.label,
    ranAt: now,
    ...reported,
  };
}

/** The shape the client reads. Snake case, like the rest of this API. */
export function runForApi(run: GameCollectionRun) {
  return {
    id: run.id,
    device: run.deviceName,
    ran_at: run.ranAt,
    tokens: run.tokens,
    pull_requests: run.pullRequests,
    commits: run.commits,
    insertions: run.insertions,
    deletions: run.deletions,
    error: run.error,
  };
}

/**
 * Which machines a gathering run can actually be asked of.
 *
 * Only ones with an agent currently polling. A command queued for a machine
 * that is not listening sits there until it is, which for a laptop that has
 * been shut for a week means a run firing at a moment nobody asked for it --
 * and the person who pressed the button was told nothing had happened.
 */
export function reachable(devices: Device[], now: number, within: number): Device[] {
  return devices.filter(
    (device) => !device.revokedAt && device.agentSeenAt && now - device.agentSeenAt <= within,
  );
}
