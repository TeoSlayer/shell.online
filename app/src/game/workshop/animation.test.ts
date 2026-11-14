import { describe, expect, it } from "vitest";
import {
  FRAME_COUNTS,
  TRANSITION_MS,
  frameAt,
  isImmediatePose,
  isMotionPose,
  selectFrame,
  selectPose,
  type Facing,
  type PoseInput,
} from "./animation";

function input(overrides: Partial<PoseInput> = {}): PoseInput {
  return {
    evidence: "unknown",
    connection: "connected",
    receiving: false,
    attention: false,
    reducedMotion: false,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("selectPose", () => {
  it("disconnected wins over everything", () => {
    expect(selectPose(input({ connection: "disconnected", evidence: "busy" }))).toBe("disconnected");
  });

  it("stale wins over evidence", () => {
    expect(selectPose(input({ connection: "stale", evidence: "busy" }))).toBe("stale");
  });

  it("receiving wins over evidence", () => {
    expect(selectPose(input({ receiving: true, evidence: "busy" }))).toBe("receiving");
  });

  it("attention wins over idle evidence", () => {
    expect(selectPose(input({ attention: true, evidence: "idle" }))).toBe("attention");
  });

  it("busy evidence → working", () => {
    expect(selectPose(input({ evidence: "busy" }))).toBe("working");
  });

  it("idle evidence → idle", () => {
    expect(selectPose(input({ evidence: "idle" }))).toBe("idle");
  });

  it("output evidence → reading", () => {
    expect(selectPose(input({ evidence: "output" }))).toBe("reading");
  });

  it("waiting_input → attention", () => {
    expect(selectPose(input({ evidence: "waiting_input" }))).toBe("attention");
  });

  it("unknown → quiet", () => {
    expect(selectPose(input({ evidence: "unknown" }))).toBe("quiet");
  });

  it("reduced motion: busy → idle (no work loop)", () => {
    expect(selectPose(input({ evidence: "busy", reducedMotion: true }))).toBe("idle");
  });

  it("reduced motion: output → idle (no reading loop)", () => {
    expect(selectPose(input({ evidence: "output", reducedMotion: true }))).toBe("idle");
  });

  it("reduced motion: idle stays idle", () => {
    expect(selectPose(input({ evidence: "idle", reducedMotion: true }))).toBe("idle");
  });
});

describe("selectFrame", () => {
  const facing: Facing = "down";

  it("reduced motion: static frame 0, no loop", () => {
    const sel = selectFrame(input({ evidence: "busy", reducedMotion: true }), facing);
    expect(sel.pose).toBe("idle");
    expect(sel.frame).toBe(0);
    expect(sel.looping).toBe(false);
    expect(sel.transition).toBe(1);
  });

  it("stale: static, no loop, immediate", () => {
    const sel = selectFrame(input({ connection: "stale", evidence: "busy" }), facing);
    expect(sel.pose).toBe("stale");
    expect(sel.frame).toBe(0);
    expect(sel.looping).toBe(false);
  });

  it("disconnected: static, no loop, immediate", () => {
    const sel = selectFrame(input({ connection: "disconnected" }), facing);
    expect(sel.pose).toBe("disconnected");
    expect(sel.frame).toBe(0);
    expect(sel.looping).toBe(false);
  });

  it("working: loops through 8 frames", () => {
    const sel = selectFrame(input({ evidence: "busy", elapsedMs: 125 }), facing);
    expect(sel.pose).toBe("working");
    expect(sel.looping).toBe(true);
    expect(sel.frame).toBeGreaterThanOrEqual(0);
    expect(sel.frame).toBeLessThan(FRAME_COUNTS.working);
  });

  it("transition completes after 500ms", () => {
    const early = selectFrame(input({ evidence: "busy", elapsedMs: 100 }), facing);
    expect(early.transition).toBeLessThan(1);
    const late = selectFrame(input({ evidence: "busy", elapsedMs: 600 }), facing);
    expect(late.transition).toBe(1);
  });

  it("frame advances with time", () => {
    const a = selectFrame(input({ evidence: "busy", elapsedMs: 0 }), facing);
    const b = selectFrame(input({ evidence: "busy", elapsedMs: 125 }), facing);
    expect(b.frame).not.toBe(a.frame);
  });
});

describe("frameAt", () => {
  it("returns 0 for single-frame poses", () => {
    expect(frameAt("stale", 0)).toBe(0);
    expect(frameAt("disconnected", 99999)).toBe(0);
  });

  it("cycles through frames", () => {
    const frames = new Set<number>();
    for (let t = 0; t < 1000; t += 125) {
      frames.add(frameAt("working", t));
    }
    expect(frames.size).toBe(FRAME_COUNTS.working);
  });

  it("respects custom frame rate", () => {
    // At 4 fps, one frame per 250ms.
    expect(frameAt("idle", 0, 4)).toBe(0);
    expect(frameAt("idle", 250, 4)).toBe(1);
    expect(frameAt("idle", 500, 4)).toBe(2);
  });
});

describe("isMotionPose", () => {
  it("working, reading, receiving are motion", () => {
    expect(isMotionPose("working")).toBe(true);
    expect(isMotionPose("reading")).toBe(true);
    expect(isMotionPose("receiving")).toBe(true);
  });
  it("idle, quiet, stale, disconnected are not motion", () => {
    expect(isMotionPose("idle")).toBe(false);
    expect(isMotionPose("quiet")).toBe(false);
    expect(isMotionPose("stale")).toBe(false);
    expect(isMotionPose("disconnected")).toBe(false);
  });
});

describe("isImmediatePose", () => {
  it("stale and disconnected are immediate", () => {
    expect(isImmediatePose("stale")).toBe(true);
    expect(isImmediatePose("disconnected")).toBe(true);
  });
  it("working is not immediate", () => {
    expect(isImmediatePose("working")).toBe(false);
  });
});

describe("FRAME_COUNTS", () => {
  it("matches the design spec", () => {
    expect(FRAME_COUNTS.idle).toBe(4);
    expect(FRAME_COUNTS.working).toBe(8);
    expect(FRAME_COUNTS.reading).toBe(6);
    expect(FRAME_COUNTS.receiving).toBe(4);
    expect(FRAME_COUNTS.attention).toBe(4);
    expect(FRAME_COUNTS.halted).toBe(2);
  });
  it("stale and disconnected are single-frame", () => {
    expect(FRAME_COUNTS.stale).toBe(1);
    expect(FRAME_COUNTS.disconnected).toBe(1);
  });
});

describe("TRANSITION_MS", () => {
  it("is 500ms per spec", () => {
    expect(TRANSITION_MS).toBe(500);
  });
});
