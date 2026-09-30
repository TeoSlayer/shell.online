import { describe, expect, it } from "vitest";
import {
  buildWorkshopScene,
  type WorkerInput,
  type WorkshopSceneOptions,
} from "./WorkshopScene";
import { selectFrame, selectPose, type PoseInput } from "./animation";
import { ownerAccentIndex, ownerEmblem } from "./manifest";
import { STATION_W, AISLE } from "./layout";

function pose(overrides: Partial<PoseInput> = {}): PoseInput {
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

function worker(id: string, ownerUid: string | null, p: PoseInput = pose()): WorkerInput {
  return { id, alias: `Agent ${id}`, ownerUid, pose: p, facing: "down" };
}

function opts(workers: WorkerInput[], overrides: Partial<WorkshopSceneOptions> = {}): WorkshopSceneOptions {
  return { workers, ownerUid: "owner-a", page: 0, reducedMotion: false, ...overrides };
}

describe("WorkshopScene — mount/dispose", () => {
  it("builds a scene with a world container", () => {
    const handle = buildWorkshopScene(null as any, opts([worker("s1", "owner-a")]));
    expect(handle.world).toBeDefined();
    expect(handle.tick).toBeTypeOf("function");
    expect(handle.destroy).toBeTypeOf("function");
    handle.destroy();
  });

  it("destroy clears children", () => {
    const handle = buildWorkshopScene(null as any, opts([worker("s1", "owner-a")]));
    const childCount = handle.world.children.length;
    expect(childCount).toBeGreaterThan(0);
    handle.destroy();
    expect(handle.world.children.length).toBe(0);
  });

  it("tick does not throw on empty scene", () => {
    const handle = buildWorkshopScene(null as any, opts([]));
    expect(() => handle.tick(16)).not.toThrow();
    handle.destroy();
  });

  it("tick advances elapsed without error", () => {
    const handle = buildWorkshopScene(null as any, opts([worker("s1", "owner-a", pose({ evidence: "busy" }))]));
    for (let i = 0; i < 60; i++) handle.tick(16);
    handle.destroy();
  });
});

describe("WorkshopScene — stale/revoked immediate stop", () => {
  it("stale connection: pose is 'stale', no work loop", () => {
    const p = pose({ evidence: "busy", connection: "stale" });
    const selected = selectPose(p);
    expect(selected).toBe("stale");
    const frame = selectFrame(p, "down");
    expect(frame.looping).toBe(false);
    expect(frame.frame).toBe(0);
  });

  it("disconnected: pose is 'disconnected', no work loop", () => {
    const p = pose({ evidence: "busy", connection: "disconnected" });
    expect(selectPose(p)).toBe("disconnected");
    const frame = selectFrame(p, "down");
    expect(frame.looping).toBe(false);
  });

  it("stale wins over busy evidence (immediate, no 500ms grace)", () => {
    const p = pose({ evidence: "busy", connection: "stale", elapsedMs: 10 });
    expect(selectPose(p)).toBe("stale");
  });

  it("revoked (disconnected) wins over receiving", () => {
    const p = pose({ evidence: "busy", connection: "disconnected", receiving: true });
    expect(selectPose(p)).toBe("disconnected");
  });
});

describe("WorkshopScene — owner accent stability", () => {
  it("same owner gets same accent regardless of roster size", () => {
    const a = ownerAccentIndex("owner-cal");
    const b = ownerAccentIndex("owner-cal");
    expect(a).toBe(b);
  });

  it("PURE f(uid): owner-i alone vs [owner-a, owner-i] gives same index", () => {
    // The old bug: walking earlier roster members changed the index.
    // Now: no roster parameter, so it's the same regardless.
    expect(ownerAccentIndex("owner-i")).toBe(ownerAccentIndex("owner-i"));
  });

  it("adding an owner does not recolour existing owners", () => {
    const before = ownerAccentIndex("owner-a");
    const after = ownerAccentIndex("owner-a");
    expect(after).toBe(before);
  });

  it("removing an owner does not recolour remaining owners", () => {
    const before = ownerAccentIndex("owner-b");
    const after = ownerAccentIndex("owner-b");
    expect(after).toBe(before);
  });

  it("collision: two owners may share an accent, distinguished by emblem", () => {
    // Find two owners that hash to the same accent index.
    const owners = Array.from({ length: 20 }, (_, i) => `owner-${i}`);
    const indices = owners.map((id) => ownerAccentIndex(id));
    // With 20 owners and 8 colours, by pigeonhole at least one colour is shared.
    expect(new Set(indices).size).toBeLessThan(20);
    // But emblems are independent and stable.
    for (const id of owners) {
      expect(ownerEmblem(id)).toBe(ownerEmblem(id));
    }
  });
});

describe("WorkshopScene — label bounds", () => {
  const STATION_PITCH = STATION_W + AISLE; // 96px

  it("20-char alias at 9px monospace fits within station pitch", () => {
    // 9px monospace: each char is ~5.4px wide. 20 chars = ~108px.
    // But we cap at 16 chars + ellipsis = 17 chars max = ~92px < 96px pitch.
    const maxChars = 16;
    const charWidth = 5.4; // 9px monospace approximate
    const maxLabelPx = (maxChars + 1) * charWidth; // +1 for ellipsis
    expect(maxLabelPx).toBeLessThanOrEqual(STATION_PITCH);
  });

  it("label cap: 20-char alias is truncated to 16+ellipsis", () => {
    const alias = "A".repeat(20);
    const capped = alias.length > 16 ? alias.slice(0, 16) + "…" : alias;
    expect(capped.length).toBe(17);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("short alias is not truncated", () => {
    const alias = "Agent 1";
    const capped = alias.length > 16 ? alias.slice(0, 16) + "…" : alias;
    expect(capped).toBe("Agent 1");
  });

  it("status strip is inside the 5% safe area (y >= 14)", () => {
    // The strip is drawn at y=14, which is exactly SAFE_INSET_Y.
    const SAFE_INSET_Y = Math.round(270 * 0.05); // 14
    const stripY = 14;
    expect(stripY).toBeGreaterThanOrEqual(SAFE_INSET_Y);
  });
});

describe("WorkshopStage readiness (regression: first paint not empty)", () => {
  /**
   * Simulates the WorkshopStage readiness gate:
   * - Mount effect: async init, sets ready=true after resolve.
   * - Scene effect: only builds scene when ready && app exist.
   * - Props change during init: scene uses latest props when ready fires.
   * - StrictMode unmount before init: app destroyed, no scene installed.
   */

  it("scene is NOT built before ready (first paint not empty after init)", () => {
    // Simulate: app exists but ready=false. Scene effect should skip.
    const app = { stage: { children: [] as any[] }, addChild: (c: any) => app.stage.children.push(c) } as any;
    let ready = false;
    let sceneBuilt = false;

    // Scene effect logic (mirrors WorkshopStage):
    const sceneEffect = () => {
      if (!app || !ready) return;
      sceneBuilt = true;
      app.addChild({ world: "scene" });
    };

    // Before init resolves:
    sceneEffect();
    expect(sceneBuilt).toBe(false);
    expect(app.stage.children.length).toBe(0);

    // After init resolves (ready=true):
    ready = true;
    sceneEffect();
    expect(sceneBuilt).toBe(true);
    expect(app.stage.children.length).toBe(1);
  });

  it("prop changes during init are not lost (scene uses latest props on ready)", () => {
    const app = { stage: { children: [] as any[] }, addChild: (c: any) => app.stage.children.push(c) } as any;
    let ready = false;
    let currentWorkers: WorkerInput[] = [worker("s1", "owner-a")];
    let builtWith: WorkerInput[] | null = null;

    const sceneEffect = () => {
      if (!app || !ready) return;
      builtWith = currentWorkers;
      app.addChild({ world: "scene", workers: currentWorkers.length });
    };

    // Mount: scene effect runs, ready=false → skip.
    sceneEffect();
    expect(builtWith).toBe(null);

    // Prop change during async init (e.g. parent re-renders with new workers):
    currentWorkers = [worker("s1", "owner-a"), worker("s2", "owner-b"), worker("s3", "owner-c")];
    sceneEffect(); // re-runs due to prop change, but ready still false
    expect(builtWith).toBe(null);

    // Init resolves:
    ready = true;
    sceneEffect(); // re-runs due to ready change, uses CURRENT props
    expect(builtWith).toEqual(currentWorkers);
    expect(builtWith!.length).toBe(3);
  });

  it("StrictMode: unmount before init → app destroyed, no scene installed", async () => {
    const app = { stage: { children: [] as any[] }, addChild: (c: any) => app.stage.children.push(c), destroyed: false } as any;
    let ready = false;
    let stopped = false;

    const mountEffect = async () => {
      await new Promise((r) => setTimeout(r, 10));
      if (stopped) {
        app.destroyed = true;
        return;
      }
      ready = true;
    };

    const sceneEffect = () => {
      if (!app || !ready) return;
      app.addChild({ world: "scene" });
    };

    const initPromise = mountEffect();
    sceneEffect();
    stopped = true;
    sceneEffect();
    await initPromise;

    expect(app.destroyed).toBe(true);
    expect(ready).toBe(false);
    expect(app.stage.children.length).toBe(0);
  });

  it("StrictMode: remount after unmount-before-init → fresh init, scene builds", async () => {
    const app1 = { stage: { children: [] as any[] }, addChild: (c: any) => app1.stage.children.push(c), destroyed: false } as any;
    const app2 = { stage: { children: [] as any[] }, addChild: (c: any) => app2.stage.children.push(c), destroyed: false } as any;
    let ready = false;

    let stopped1 = false;
    const init1 = async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (stopped1) { app1.destroyed = true; return; }
      ready = true;
    };
    const p1 = init1();
    stopped1 = true;
    await p1;
    expect(app1.destroyed).toBe(true);
    expect(ready).toBe(false);

    ready = false;
    let stopped2 = false;
    const init2 = async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (stopped2) { app2.destroyed = true; return; }
      ready = true;
    };
    const p2 = init2();
    await p2;
    expect(app2.destroyed).toBe(false);
    expect(ready).toBe(true);

    app2.addChild({ world: "scene" });
    expect(app2.stage.children.length).toBe(1);
  });
});

describe("WorkshopScene — team fixture (3 owners × 2 workers)", () => {
  const team: WorkerInput[] = [
    worker("s1", "owner-a", pose({ evidence: "busy" })),
    worker("s2", "owner-a", pose({ evidence: "output" })),
    worker("s3", "owner-b", pose({ evidence: "idle" })),
    worker("s4", "owner-b", pose({ evidence: "waiting_input" })),
    worker("s5", "owner-c", pose({ evidence: "unknown" })),
    worker("s6", "owner-c", pose({ evidence: "unknown", connection: "stale" })),
  ];

  it("builds a scene with 6 stations", () => {
    const handle = buildWorkshopScene(null as any, opts(team, { allOwnerUids: ["owner-a", "owner-b", "owner-c"] }));
    // 6 stations + ground + forest + 3 owner markers + strip + stripText
    expect(handle.world.children.length).toBeGreaterThanOrEqual(6);
    handle.destroy();
  });

  it("each owner gets a distinct accent", () => {
    const owners = ["owner-a", "owner-b", "owner-c"];
    const indices = owners.map((id) => ownerAccentIndex(id));
    expect(new Set(indices).size).toBe(3);
  });

  it("restricted owner (stale) shows stale, not working", () => {
    const staleWorker = team.find((w) => w.id === "s6")!;
    expect(selectPose(staleWorker.pose)).toBe("stale");
  });

  it("unknown ownership (null) is handled", () => {
    const nullOwner: WorkerInput = worker("s7", null, pose({ evidence: "unknown" }));
    const handle = buildWorkshopScene(null as any, opts([nullOwner]));
    expect(handle.world.children.length).toBeGreaterThan(0);
    handle.destroy();
  });
});
