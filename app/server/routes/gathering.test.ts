import { describe, expect, it } from "vitest";
import { reachable, readRun, runForApi, runFrom } from "./gathering";
import type { Device } from "../lib/types";

/**
 * What a machine is allowed to say, and how hard it is believed.
 *
 * This is the one part of the game that reads real work and spends real money,
 * so it is the one part written defensively. An agent is a program on
 * somebody's laptop; these figures are summed and never recomputed, so a single
 * absurd report would make the vial meaningless for good.
 */

const NOW = Date.parse("2026-09-16T12:00:00Z");
const MINUTE = 60_000;

const device = (over: Partial<Device> = {}): Device => ({
  id: "dev-1",
  label: "laptop",
  createdAt: NOW - 1000,
  lastSeenAt: NOW,
  agentSeenAt: NOW,
  ...over,
});

describe("reading a report", () => {
  it("takes the counts it was given", () => {
    const run = readRun({
      tokens: 1200,
      pull_requests: 3,
      commits: 9,
      insertions: 410,
      deletions: 88,
    });
    expect(run).toEqual({
      tokens: 1200,
      pullRequests: 3,
      commits: 9,
      insertions: 410,
      deletions: 88,
      error: "",
    });
  });

  it("refuses a negative count", () => {
    /* A negative token count would run somebody's total backwards. */
    expect(readRun({ tokens: -500 }).tokens).toBe(0);
    expect(readRun({ commits: -1 }).commits).toBe(0);
  });

  it("refuses something that is not a number", () => {
    expect(readRun({ tokens: "lots" }).tokens).toBe(0);
    expect(readRun({ tokens: Number.NaN }).tokens).toBe(0);
    expect(readRun({ tokens: Number.POSITIVE_INFINITY }).tokens).toBe(0);
    expect(readRun({ tokens: null }).tokens).toBe(0);
  });

  it("caps a figure that would make the vial absurd", () => {
    /*
     * These are summed and never recomputed. One report of a quadrillion
     * tokens is not a display bug that can be refreshed away; it is the
     * account's total, for good.
     */
    expect(readRun({ tokens: 1e18 }).tokens).toBeLessThanOrEqual(10_000_000_000);
  });

  it("does not clip a heavy but honest week", () => {
    /*
     * A real machine reported eighty-three million tokens for three days of
     * ordinary work. A cap that clips an honest report is worse than no cap:
     * the number it produces is wrong and looks reasonable.
     */
    expect(readRun({ tokens: 83_000_000 }).tokens).toBe(83_000_000);
  });

  it("rounds rather than storing a fraction of a token", () => {
    expect(readRun({ tokens: 12.7 }).tokens).toBe(12);
  });

  it("takes a failure as a sentence, and a short one", () => {
    expect(readRun({ error: "no git on PATH" }).error).toBe("no git on PATH");
    expect(readRun({ error: "x".repeat(5000) }).error.length).toBeLessThanOrEqual(200);
    expect(readRun({ error: { deeply: "nested" } }).error).toBe("");
  });

  it("survives an empty body", () => {
    expect(readRun({})).toEqual({
      tokens: 0,
      pullRequests: 0,
      commits: 0,
      insertions: 0,
      deletions: 0,
      error: "",
    });
  });

  it("has nowhere to put anything but numbers", () => {
    /*
     * The guard this whole file exists for. There is no field for a branch
     * name, a commit message, a path, a diff or a line of output, and a shape
     * that cannot carry those cannot leak them because somebody later found it
     * convenient. If this test has to change, that should be argued about.
     */
    const run = readRun({
      tokens: 5,
      branch: "fix/the-thing",
      message: "fix: the thing",
      path: "/Users/someone/work/secret",
      diff: "- password = hunter2",
    });
    expect(Object.keys(run).sort()).toEqual([
      "commits",
      "deletions",
      "error",
      "insertions",
      "pullRequests",
      "tokens",
    ]);
    expect(JSON.stringify(run)).not.toContain("hunter2");
    expect(JSON.stringify(run)).not.toContain("fix/the-thing");
  });
});

describe("recording it", () => {
  it("names the machine it came from", () => {
    const run = runFrom("run-1", "uid-1", { id: "dev-1", label: "workshop" }, readRun({ tokens: 7 }), NOW);
    expect(run.deviceId).toBe("dev-1");
    expect(run.deviceName).toBe("workshop");
    expect(run.ranAt).toBe(NOW);
    expect(run.uid).toBe("uid-1");
  });

  it("hands the client snake case, like the rest of this API", () => {
    const run = runFrom("run-1", "uid-1", { id: "dev-1", label: "laptop" }, readRun({ tokens: 7 }), NOW);
    expect(Object.keys(runForApi(run)).sort()).toEqual([
      "commits",
      "deletions",
      "device",
      "error",
      "id",
      "insertions",
      "pull_requests",
      "ran_at",
      "tokens",
    ]);
  });

  it("does not hand back the uid or the device id", () => {
    /*
     * The caller knows who they are, and a device id is an address a browser
     * has no use for. Both are fields to keep in step for nothing.
     */
    const wire = runForApi(runFrom("run-1", "uid-1", { id: "dev-1", label: "laptop" }, readRun({}), NOW));
    expect(wire).not.toHaveProperty("uid");
    expect(wire).not.toHaveProperty("device_id");
  });
});

describe("which machines can be asked", () => {
  it("takes one whose agent is polling", () => {
    expect(reachable([device()], NOW, 5 * MINUTE)).toHaveLength(1);
  });

  it("leaves out one that has never run an agent", () => {
    expect(reachable([device({ agentSeenAt: undefined })], NOW, 5 * MINUTE)).toHaveLength(0);
  });

  it("leaves out one that stopped listening", () => {
    /*
     * A command queued for a machine that is not listening sits there until it
     * is. For a laptop shut for a week that means a run firing at a moment
     * nobody asked for it, long after the person who pressed the button was
     * told nothing had happened.
     */
    expect(reachable([device({ agentSeenAt: NOW - 60 * MINUTE })], NOW, 5 * MINUTE)).toHaveLength(0);
  });

  it("leaves out one that has been unlinked", () => {
    expect(reachable([device({ revokedAt: NOW - 1000 })], NOW, 5 * MINUTE)).toHaveLength(0);
  });

  it("takes several", () => {
    const machines = reachable(
      [device(), device({ id: "dev-2", label: "workshop" }), device({ id: "dev-3", agentSeenAt: undefined })],
      NOW,
      5 * MINUTE,
    );
    expect(machines.map((entry) => entry.label)).toEqual(["laptop", "workshop"]);
  });
});
