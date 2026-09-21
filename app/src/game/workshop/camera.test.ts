import { describe, expect, it } from "vitest";
import {
  LABEL_ZOOM_THRESHOLD,
  MAX_ZOOM,
  clampPosition,
  clampZoom,
  fitAll,
  focusOwner,
  focusRegion,
  labelsVisible,
  minZoom,
  panTo,
  screenToWorld,
  worldToScreen,
  type CameraState,
} from "./camera";
import { VIEWPORT_H, VIEWPORT_W, buildWorld, type SectorSlot } from "./world";

function slots(entries: [string, number, number][]): SectorSlot[] {
  return entries.map(([ownerUid, gridX, gridY]) => ({ ownerUid, gridX, gridY }));
}

const SEED = 42;

function world3() {
  return buildWorld(
    slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0]]),
    SEED,
    new Map([["o1", ["s1", "s2"]], ["o2", ["s3", "s4"]], ["o3", ["s5", "s6"]]]),
  );
}

describe("fitAll", () => {
  it("zooms out to see the entire world", () => {
    const world = world3();
    const cam = fitAll(world);
    expect(cam.zoom).toBeLessThan(1.0);
    const viewW = VIEWPORT_W / cam.zoom;
    const viewH = VIEWPORT_H / cam.zoom;
    expect(viewW).toBeGreaterThanOrEqual(world.width);
    expect(viewH).toBeGreaterThanOrEqual(world.height);
  });

  it("is deterministic (no time dependency, no auto-pan)", () => {
    const world = world3();
    expect(fitAll(world)).toEqual(fitAll(world));
  });
});

describe("focusRegion — zoom clamped BEFORE origin", () => {
  it("below-min zoom: clamped to default min, target at viewport centre", () => {
    // focusRegion uses default min zoom (0.1) when no world is provided.
    const cam = focusRegion(600, 300, 0.05);
    expect(cam.zoom).toBe(0.1);
    // Target (600,300) should be at the viewport centre.
    const screen = worldToScreen(cam, 600, 300);
    expect(screen.x).toBeCloseTo(VIEWPORT_W / 2, 1);
    expect(screen.y).toBeCloseTo(VIEWPORT_H / 2, 1);
  });

  it("below-world-min zoom via focusOwner: target at centre", () => {
    const world = world3();
    const cam = focusOwner(world, "o1")!;
    const sector = world.sectors.find((s) => s.ownerUid === "o1")!;
    const cx = sector.x + sector.w / 2;
    const cy = sector.y + sector.h / 2;
    const screen = worldToScreen(cam, cx, cy);
    expect(screen.x).toBeCloseTo(VIEWPORT_W / 2, 1);
    expect(screen.y).toBeCloseTo(VIEWPORT_H / 2, 1);
  });

  it("above-max zoom: clamped to MAX_ZOOM, target at centre", () => {
    const cam = focusRegion(600, 300, 2.0);
    expect(cam.zoom).toBe(MAX_ZOOM);
    const screen = worldToScreen(cam, 600, 300);
    expect(screen.x).toBeCloseTo(VIEWPORT_W / 2, 1);
    expect(screen.y).toBeCloseTo(VIEWPORT_H / 2, 1);
  });

  it("zoom 0: clamped to min, no Infinity in x/y", () => {
    const cam = focusRegion(600, 300, 0);
    expect(Number.isFinite(cam.x)).toBe(true);
    expect(Number.isFinite(cam.y)).toBe(true);
    expect(cam.zoom).toBeGreaterThan(0);
  });

  it("NaN zoom: throws", () => {
    expect(() => focusRegion(600, 300, NaN)).toThrow();
  });

  it("NaN centre: throws", () => {
    expect(() => focusRegion(NaN, 300, 0.5)).toThrow();
    expect(() => focusRegion(600, NaN, 0.5)).toThrow();
  });

  it("Infinity centre: throws", () => {
    expect(() => focusRegion(Infinity, 300, 0.5)).toThrow();
  });

  it("valid zoom: target at centre", () => {
    const cam = focusRegion(600, 300, 0.5);
    const screen = worldToScreen(cam, 600, 300);
    expect(screen.x).toBeCloseTo(VIEWPORT_W / 2, 1);
    expect(screen.y).toBeCloseTo(VIEWPORT_H / 2, 1);
  });
});

describe("focusOwner", () => {
  it("zooms in on the owner's sector", () => {
    const world = world3();
    const cam = focusOwner(world, "o1");
    expect(cam).not.toBeNull();
    expect(cam!.zoom).toBeGreaterThan(fitAll(world).zoom);
  });

  it("returns null for unknown owner", () => {
    const world = world3();
    expect(focusOwner(world, "unknown")).toBeNull();
  });

  it("target is at viewport centre", () => {
    const world = world3();
    const cam = focusOwner(world, "o1")!;
    const sector = world.sectors.find((s) => s.ownerUid === "o1")!;
    const cx = sector.x + sector.w / 2;
    const cy = sector.y + sector.h / 2;
    const screen = worldToScreen(cam, cx, cy);
    expect(screen.x).toBeCloseTo(VIEWPORT_W / 2, 1);
    expect(screen.y).toBeCloseTo(VIEWPORT_H / 2, 1);
  });
});

describe("clampPosition — centred offset when viewport > world", () => {
  it("preserves centered negative offset when viewport is wider than world", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    const cam = fitAll(world);
    const clamped = clampPosition(cam, world);
    // World is smaller than viewport on x-axis: should be centred (negative x).
    const viewW = VIEWPORT_W / clamped.zoom;
    if (viewW > world.width) {
      expect(clamped.x).toBeCloseTo((world.width - viewW) / 2, 1);
      expect(clamped.x).toBeLessThan(0);
    }
  });

  it("does not jump to 0 when viewport > world (regression)", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    const cam = fitAll(world);
    const clamped = clampPosition(cam, world);
    // The centred offset should be preserved, not pinned to 0.
    const viewW = VIEWPORT_W / clamped.zoom;
    const viewH = VIEWPORT_H / clamped.zoom;
    if (viewW > world.width) {
      expect(clamped.x).not.toBe(0);
    }
    if (viewH > world.height) {
      expect(clamped.y).not.toBe(0);
    }
  });

  it("clamps to world bounds when viewport < world", () => {
    const world = world3();
    const cam: CameraState = { x: -1000, y: -1000, zoom: 1.0 };
    const clamped = clampPosition(cam, world);
    expect(clamped.x).toBeGreaterThanOrEqual(0);
    expect(clamped.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps camera within bounds when panning right/down", () => {
    const world = world3();
    const cam: CameraState = { x: 99999, y: 99999, zoom: 1.0 };
    const clamped = clampPosition(cam, world);
    expect(clamped.x).toBeLessThanOrEqual(world.width - VIEWPORT_W);
    expect(clamped.y).toBeLessThanOrEqual(world.height - VIEWPORT_H);
  });
});

describe("clampZoom", () => {
  it("clamps to min/max", () => {
    const world = world3();
    const min = minZoom(world);
    expect(clampZoom(0.001, world)).toBe(min);
    expect(clampZoom(10, world)).toBe(MAX_ZOOM);
    expect(clampZoom(0.5, world)).toBe(0.5);
  });

  it("rejects NaN", () => {
    expect(() => clampZoom(NaN)).toThrow();
  });

  it("rejects Infinity", () => {
    expect(() => clampZoom(Infinity)).toThrow();
  });
});

describe("labelsVisible", () => {
  it("hidden at very low zoom (fit-all of large world)", () => {
    const world = buildWorld(
      slots(Array.from({ length: 64 }, (_, i) => [`o${i}`, i % 8, Math.floor(i / 8)])),
      SEED,
      new Map(),
    );
    const cam = fitAll(world);
    expect(labelsVisible(cam.zoom)).toBe(false);
  });

  it("visible at focus-owner zoom", () => {
    const world = world3();
    const cam = focusOwner(world, "o1")!;
    expect(labelsVisible(cam.zoom)).toBe(true);
  });

  it("threshold is 0.4", () => {
    expect(LABEL_ZOOM_THRESHOLD).toBe(0.4);
    expect(labelsVisible(0.39)).toBe(false);
    expect(labelsVisible(0.4)).toBe(true);
  });
});

describe("panTo", () => {
  it("centres the viewport on the target without changing zoom", () => {
    const cam: CameraState = { x: 0, y: 0, zoom: 0.5 };
    const panned = panTo(cam, 500, 300);
    expect(panned.zoom).toBe(0.5);
    const viewCX = panned.x + VIEWPORT_W / panned.zoom / 2;
    expect(viewCX).toBeCloseTo(500, 0);
  });

  it("rejects NaN target", () => {
    const cam: CameraState = { x: 0, y: 0, zoom: 0.5 };
    expect(() => panTo(cam, NaN, 300)).toThrow();
  });

  it("rejects Infinity target", () => {
    const cam: CameraState = { x: 0, y: 0, zoom: 0.5 };
    expect(() => panTo(cam, Infinity, 300)).toThrow();
  });
});

describe("worldToScreen / screenToWorld", () => {
  it("round-trips", () => {
    const cam: CameraState = { x: 100, y: 50, zoom: 0.5 };
    const screen = worldToScreen(cam, 200, 150);
    const world = screenToWorld(cam, screen.x, screen.y);
    expect(world.x).toBeCloseTo(200, 5);
    expect(world.y).toBeCloseTo(150, 5);
  });

  it("is invertible for normal finite cameras", () => {
    const cam: CameraState = { x: -50, y: -30, zoom: 0.7 };
    const screen = worldToScreen(cam, 100, 200);
    const world = screenToWorld(cam, screen.x, screen.y);
    expect(world.x).toBeCloseTo(100, 5);
    expect(world.y).toBeCloseTo(200, 5);
  });
});

describe("24-worker: pan not teleport", () => {
  it("all stations in same world; camera pans between sectors", () => {
    const world = buildWorld(
      slots(Array.from({ length: 24 }, (_, i) => [`o${i}`, i % 5, Math.floor(i / 5)])),
      SEED,
      new Map(Array.from({ length: 24 }, (_, i) => [`o${i}`, ["s1", "s2"]] as [string, string[]])),
    );
    const allStations = world.sectors.flatMap((s) => s.stations);
    expect(allStations).toHaveLength(48);
    for (const s of allStations) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(world.width);
    }
    const cam1 = focusOwner(world, "o0")!;
    const cam2 = focusOwner(world, "o23")!;
    expect(cam1.x).not.toBe(cam2.x);
    expect(world.sectors.flatMap((s) => s.stations)).toHaveLength(48);
  });
});

describe("no auto-pan / no wandering", () => {
  it("camera is a pure function of (world, target) — no time, no randomness", () => {
    const world = world3();
    for (let i = 0; i < 5; i++) {
      expect(fitAll(world)).toEqual(fitAll(world));
      expect(focusOwner(world, "o1")).toEqual(focusOwner(world, "o1"));
    }
  });
});
