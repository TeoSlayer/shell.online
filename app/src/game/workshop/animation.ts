/**
 * Workshop animation: pure pose/transition selector.
 *
 * Consumes explicit normalized pose inputs (from the observation contract)
 * and selects the correct animation frame. No Pixi, no DOM, no HTTP.
 *
 * Rules:
 * - Animations smooth transitions for at most 500 ms.
 * - Stale/disconnected evidence stops work loops immediately.
 * - Reduced motion: no travelling sprites, no looping work animation.
 *   Static pose only.
 * - Revocation/access-loss/disconnect wins immediately (no 500ms grace).
 */

export type Pose =
  | "idle"
  | "working"
  | "reading"
  | "receiving"
  | "attention"
  | "halted"
  | "quiet"
  | "stale"
  | "disconnected";

export type Facing = "down" | "left" | "right" | "up";

export interface PoseInput {
  /** Normalized activity evidence state. */
  evidence: "busy" | "idle" | "waiting_input" | "output" | "unknown";
  /** Connection state. */
  connection: "connected" | "disconnected" | "stale" | "unknown";
  /** Whether a message packet is being received. */
  receiving: boolean;
  /** Whether the worker needs to show attention (e.g. attention marker). */
  attention: boolean;
  /** Reduced motion preference. */
  reducedMotion: boolean;
  /** Milliseconds since the last state change (for transition timing). */
  elapsedMs: number;
}

export interface FrameSelection {
  pose: Pose;
  facing: Facing;
  /** Frame index within the pose's animation. -1 for static (reduced motion). */
  frame: number;
  /** Whether the animation is looping. */
  looping: boolean;
  /** Transition progress 0..1 (1 = fully arrived at target pose). */
  transition: number;
}

export const TRANSITION_MS = 500;

/** Frame counts per pose (from the design spec). */
export const FRAME_COUNTS: Record<Pose, number> = {
  idle: 4,
  working: 8,
  reading: 6,
  receiving: 4,
  attention: 4,
  halted: 2,
  quiet: 2,
  stale: 1,
  disconnected: 1,
};

/**
 * Select the target pose from normalized inputs.
 *
 * Priority (highest wins):
 * 1. disconnected — explicit offline marker
 * 2. stale — stop work, show stale marker
 * 3. receiving — packet receive gesture
 * 4. attention — worker turns toward owner
 * 5. evidence-based: busy → working, idle → idle, output → reading,
 *    waiting_input → attention, unknown → quiet
 */
export function selectPose(input: PoseInput): Pose {
  if (input.connection === "disconnected") return "disconnected";
  if (input.connection === "stale") return "stale";
  if (input.receiving) return "receiving";
  if (input.attention) return "attention";

  switch (input.evidence) {
    case "busy":
      return input.reducedMotion ? "idle" : "working";
    case "idle":
      return "idle";
    case "waiting_input":
      return "attention";
    case "output":
      return input.reducedMotion ? "idle" : "reading";
    case "unknown":
      return "quiet";
  }
}

/**
 * Compute the full frame selection for a worker.
 *
 * `facing` is supplied by the layout (which direction the worker faces).
 * `frameRate` is frames per second for the animation (default 8 fps per spec).
 */
export function selectFrame(
  input: PoseInput,
  facing: Facing,
  frameRate = 8,
): FrameSelection {
  const pose = selectPose(input);

  if (input.reducedMotion || pose === "stale" || pose === "disconnected") {
    return { pose, facing, frame: 0, looping: false, transition: 1 };
  }

  const count = FRAME_COUNTS[pose];
  const transition = Math.min(1, input.elapsedMs / TRANSITION_MS);
  const frameMs = 1000 / frameRate;
  const frame = Math.floor(input.elapsedMs / frameMs) % count;

  return { pose, facing, frame, looping: true, transition };
}

/**
 * Whether a pose involves motion (for reduced-motion and stale checks).
 */
export function isMotionPose(pose: Pose): boolean {
  return pose === "working" || pose === "reading" || pose === "receiving";
}

/**
 * Whether the pose should stop immediately on stale/disconnect (no transition).
 */
export function isImmediatePose(pose: Pose): boolean {
  return pose === "stale" || pose === "disconnected";
}

/**
 * Compute the frame for a given wall-clock time and pose.
 * Used by the ticker to advance animations.
 */
export function frameAt(pose: Pose, elapsedMs: number, frameRate = 8): number {
  const count = FRAME_COUNTS[pose];
  if (count <= 1) return 0;
  const frameMs = 1000 / frameRate;
  return Math.floor(elapsedMs / frameMs) % count;
}
