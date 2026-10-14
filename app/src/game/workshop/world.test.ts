import { describe, expect, it } from "vitest";
import {
  MAX_GRID,
  MAX_STATIONS_PER_SECTOR,
  SECTOR_H,
  SECTOR_W,
  VIEWPORT_H,
  VIEWPORT_W,
  WorldError,
  allocateDemoSlots,
  buildWorld,
  findSector,
  visibleSectors,
  worldBounds,
  type SectorSlot,
} from "./world";

function slots(entries: [string, number, number][]): SectorSlot[] {
  return entries.map(([ownerUid, gridX, gridY]) => ({ ownerUid, gridX, gridY }));
}

function stations(owners: [string, string[]][]): Map<string, string[]> {
  return new Map(owners);
}

const SEED = 42;

describe("buildWorld — growth", () => {
  it("1 owner: 1 sector, world ≈ 1 viewport + forest", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, stations([["o1", ["s1", "s2", "s3"]]]));
    expect(world.sectors).toHaveLength(1);
    expect(world.width).toBeGreaterThanOrEqual(VIEWPORT_W);
    expect(world.height).toBeGreaterThanOrEqual(VIEWPORT_H);
    expect(world.gridCols).toBe(1);
    expect(world.gridRows).toBe(1);
  });

  it("3 owners (1 row): 3 sectors, world 3× wider", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0]]),
      SEED,
      stations([["o1", ["s1"]], ["o2", ["s2"]], ["o3", ["s3"]]]),
    );
    expect(world.sectors).toHaveLength(3);
    expect(world.gridCols).toBe(3);
    expect(world.gridRows).toBe(1);
    expect(world.width).toBeGreaterThan(3 * SECTOR_W);
  });

  it("8 owners (3+3+2 grid): 8 sectors", () => {
    const world = buildWorld(
      slots([
        ["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0],
        ["o4", 0, 1], ["o5", 1, 1], ["o6", 2, 1],
        ["o7", 0, 2], ["o8", 1, 2],
      ]),
      SEED,
      stations(Array.from({ length: 8 }, (_, i) => [`o${i + 1}`, ["s"]]) as [string, string[]][]),
    );
    expect(world.sectors).toHaveLength(8);
    expect(world.gridCols).toBe(3);
    expect(world.gridRows).toBe(3);
  });

  it("24 owners: 24 sectors, world grows", () => {
    const s = slots(Array.from({ length: 24 }, (_, i) => [`o${i}`, i % 5, Math.floor(i / 5)]));
    const world = buildWorld(s, SEED, stations(s.map((x) => [x.ownerUid, ["s1", "s2"]] as [string, string[]])));
    expect(world.sectors).toHaveLength(24);
    expect(world.gridCols).toBe(5);
    expect(world.gridRows).toBe(5);
  });

  it("64 owners: 64 sectors, world is large", () => {
    const s = slots(Array.from({ length: 64 }, (_, i) => [`o${i}`, i % 8, Math.floor(i / 8)]));
    const world = buildWorld(s, SEED, stations(s.map((x) => [x.ownerUid, ["s1"]] as [string, string[]])));
    expect(world.sectors).toHaveLength(64);
    expect(world.gridCols).toBe(8);
    expect(world.gridRows).toBe(8);
    expect(world.width).toBeGreaterThan(8 * SECTOR_W);
    expect(world.height).toBeGreaterThan(8 * SECTOR_H);
  });
});

describe("buildWorld — stability (append-only)", () => {
  it("existing sector coordinates unchanged after append", () => {
    const base = slots([["o1", 0, 0], ["o2", 1, 0]]);
    const w1 = buildWorld(base, SEED, stations([["o1", ["s"]], ["o2", ["s"]]]));
    const appended = slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0]]);
    const w2 = buildWorld(appended, SEED, stations([["o1", ["s"]], ["o2", ["s"]], ["o3", ["s"]]]));
    expect(w2.sectors.find((s) => s.ownerUid === "o1")!.x).toBe(w1.sectors.find((s) => s.ownerUid === "o1")!.x);
    expect(w2.sectors.find((s) => s.ownerUid === "o1")!.y).toBe(w1.sectors.find((s) => s.ownerUid === "o1")!.y);
    expect(w2.sectors.find((s) => s.ownerUid === "o2")!.x).toBe(w1.sectors.find((s) => s.ownerUid === "o2")!.x);
    expect(w2.sectors.find((s) => s.ownerUid === "o2")!.y).toBe(w1.sectors.find((s) => s.ownerUid === "o2")!.y);
  });

  it("reorder slots: same world (layout is slot-driven, not order-driven)", () => {
    const a = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), SEED, stations([["o1", ["s"]], ["o2", ["s"]]]));
    const b = buildWorld(slots([["o2", 1, 0], ["o1", 0, 0]]), SEED, stations([["o1", ["s"]], ["o2", ["s"]]]));
    expect(a.sectors.find((s) => s.ownerUid === "o1")!.x).toBe(b.sectors.find((s) => s.ownerUid === "o1")!.x);
    expect(a.sectors.find((s) => s.ownerUid === "o1")!.y).toBe(b.sectors.find((s) => s.ownerUid === "o1")!.y);
  });

  it("filter slots: remaining sectors keep positions", () => {
    const full = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0]]),
      SEED,
      stations([["o1", ["s"]], ["o2", ["s"]], ["o3", ["s"]]]),
    );
    const filtered = buildWorld(
      slots([["o1", 0, 0], ["o3", 2, 0]]),
      SEED,
      stations([["o1", ["s"]], ["o3", ["s"]]]),
    );
    expect(filtered.sectors.find((s) => s.ownerUid === "o1")!.x).toBe(full.sectors.find((s) => s.ownerUid === "o1")!.x);
    expect(filtered.sectors.find((s) => s.ownerUid === "o3")!.x).toBe(full.sectors.find((s) => s.ownerUid === "o3")!.x);
  });
});

describe("buildWorld — validation (bounded inputs)", () => {
  it("rejects sector collision (two owners, same grid position)", () => {
    expect(() =>
      buildWorld(slots([["o1", 0, 0], ["o2", 0, 0]]), SEED, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects negative grid coordinates", () => {
    expect(() =>
      buildWorld(slots([["o1", -1, 0]]), SEED, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects non-integer grid coordinates", () => {
    expect(() =>
      buildWorld(slots([["o1", 0.5, 0]]), SEED, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects empty ownerUid", () => {
    expect(() =>
      buildWorld(slots([["", 0, 0]]), SEED, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects gridX >= MAX_GRID (prevents unbounded prop loops)", () => {
    expect(() =>
      buildWorld(slots([["o1", MAX_GRID, 0]]), SEED, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects gridY >= MAX_GRID", () => {
    expect(() =>
      buildWorld(slots([["o1", 0, MAX_GRID]]), SEED, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects Number.MAX_VALUE grid coordinate", () => {
    expect(() =>
      buildWorld(slots([["o1", Number.MAX_VALUE, 0]]), SEED, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects NaN seed", () => {
    expect(() =>
      buildWorld(slots([["o1", 0, 0]]), NaN, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects Infinity seed", () => {
    expect(() =>
      buildWorld(slots([["o1", 0, 0]]), Infinity, new Map()),
    ).toThrow(WorldError);
  });

  it("rejects -Infinity seed", () => {
    expect(() =>
      buildWorld(slots([["o1", 0, 0]]), -Infinity, new Map()),
    ).toThrow(WorldError);
  });

  it("accepts finite seed and normalizes (negative → positive, fractional → trunc)", () => {
    const a = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), 42, new Map());
    const b = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), -42, new Map());
    const c = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), 42.7, new Map());
    expect(a.props).toEqual(b.props);
    expect(a.props).toEqual(c.props);
  });
});

describe("buildWorld — deterministic props", () => {
  it("same seed → same props", () => {
    const a = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), 123, new Map());
    const b = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), 123, new Map());
    expect(a.props).toEqual(b.props);
  });

  it("different seed → different props", () => {
    const a = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), 123, new Map());
    const b = buildWorld(slots([["o1", 0, 0], ["o2", 1, 0]]), 456, new Map());
    expect(a.props).not.toEqual(b.props);
  });

  it("all props are within world bounds (no negative/outside coordinates)", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    for (const p of world.props) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(world.width);
      expect(p.y).toBeLessThanOrEqual(world.height);
    }
  });

  it("one-sector world: no props outside the world", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    const outside = world.props.filter(
      (p) => p.x < 0 || p.y < 0 || p.x > world.width || p.y > world.height,
    );
    expect(outside).toHaveLength(0);
  });
});

describe("buildWorld — no overlapping sector bounds", () => {
  it("sectors do not overlap", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 0, 1], ["o4", 1, 1]]),
      SEED,
      new Map(),
    );
    for (let i = 0; i < world.sectors.length; i++) {
      for (let j = i + 1; j < world.sectors.length; j++) {
        const a = world.sectors[i], b = world.sectors[j];
        const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
        const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });
});

describe("buildWorld — paths (nonzero length)", () => {
  it("adjacent sectors have paths with nonzero length", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 0, 1]]),
      SEED,
      new Map(),
    );
    expect(world.paths.length).toBeGreaterThanOrEqual(2);
    for (const p of world.paths) {
      const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      expect(len).toBeGreaterThan(0);
      expect(Number.isFinite(len)).toBe(true);
    }
  });

  it("horizontal path: x1 != x2, y1 == y2", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0]]),
      SEED,
      new Map(),
    );
    const hPath = world.paths.find((p) => p.from === "o1" && p.to === "o2")!;
    expect(hPath.x1).not.toBe(hPath.x2);
    expect(hPath.y1).toBe(hPath.y2);
    expect(hPath.x2 - hPath.x1).toBeGreaterThan(0);
  });

  it("vertical path: x1 == x2, y1 != y2", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 0, 1]]),
      SEED,
      new Map(),
    );
    const vPath = world.paths.find((p) => p.from === "o1" && p.to === "o2")!;
    expect(vPath.x1).toBe(vPath.x2);
    expect(vPath.y1).not.toBe(vPath.y2);
    expect(vPath.y2 - vPath.y1).toBeGreaterThan(0);
  });

  it("non-adjacent sectors have no direct path", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 5, 5]]),
      SEED,
      new Map(),
    );
    expect(world.paths).toHaveLength(0);
  });
});

describe("buildWorld — station capacity", () => {
  it("caps stations at MAX_STATIONS_PER_SECTOR", () => {
    const manyStations = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const world = buildWorld(
      slots([["o1", 0, 0]]),
      SEED,
      stations([["o1", manyStations]]),
    );
    expect(world.sectors[0].stations).toHaveLength(MAX_STATIONS_PER_SECTOR);
  });

  it("all stations fit within their sector bounds", () => {
    const manyStations = Array.from({ length: MAX_STATIONS_PER_SECTOR }, (_, i) => `s${i}`);
    const world = buildWorld(
      slots([["o1", 0, 0]]),
      SEED,
      stations([["o1", manyStations]]),
    );
    const sector = world.sectors[0];
    for (const st of sector.stations) {
      expect(st.x).toBeGreaterThanOrEqual(sector.x);
      expect(st.y).toBeGreaterThanOrEqual(sector.y);
      expect(st.x + 64).toBeLessThanOrEqual(sector.x + sector.w);
      expect(st.y + 64).toBeLessThanOrEqual(sector.y + sector.h);
    }
  });
});

describe("findSector", () => {
  it("finds the sector for an owner", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map([["o1", ["s1"]]]));
    expect(findSector(world, "o1")).toBeDefined();
  });
  it("returns undefined for unknown owner", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    expect(findSector(world, "o2")).toBeUndefined();
  });
});

describe("worldBounds", () => {
  it("contains all sectors", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0]]),
      SEED,
      new Map(),
    );
    const b = worldBounds(world);
    for (const s of world.sectors) {
      expect(s.x).toBeGreaterThanOrEqual(b.x);
      expect(s.y).toBeGreaterThanOrEqual(b.y);
      expect(s.x + s.w).toBeLessThanOrEqual(b.x + b.w);
      expect(s.y + s.h).toBeLessThanOrEqual(b.y + b.h);
    }
  });
});

describe("visibleSectors — bounded/chunk rendering", () => {
  it("only returns sectors intersecting the camera viewport", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0], ["o4", 0, 1]]),
      SEED,
      new Map(),
    );
    const o1 = world.sectors.find((s) => s.ownerUid === "o1")!;
    const visible = visibleSectors(world, o1.x, o1.y, SECTOR_W, SECTOR_H);
    expect(visible.some((s) => s.ownerUid === "o1")).toBe(true);
    expect(visible.some((s) => s.ownerUid === "o3")).toBe(false);
  });

  it("empty viewport (zero width) returns no sectors", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    expect(visibleSectors(world, 100, 100, 0, 10)).toHaveLength(0);
  });

  it("negative-area viewport returns no sectors", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    expect(visibleSectors(world, 100, 100, -1, 10)).toHaveLength(0);
    expect(visibleSectors(world, 100, 100, 10, -1)).toHaveLength(0);
  });

  it("empty viewport (zero height) returns no sectors", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    expect(visibleSectors(world, 100, 100, 10, 0)).toHaveLength(0);
  });

  it("viewport far from all sectors returns no sectors", () => {
    const world = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    const visible = visibleSectors(world, 99999, 99999, 10, 10);
    expect(visible).toHaveLength(0);
  });
});

describe("viewport vs world", () => {
  it("world grows beyond viewport as team grows", () => {
    const w1 = buildWorld(slots([["o1", 0, 0]]), SEED, new Map());
    const w8 = buildWorld(
      slots(Array.from({ length: 8 }, (_, i) => [`o${i}`, i % 3, Math.floor(i / 3)])),
      SEED,
      new Map(),
    );
    expect(w8.width).toBeGreaterThan(w1.width);
    expect(w8.height).toBeGreaterThan(w1.height);
  });

  it("3 owners x2 is a near-overview, not maximum", () => {
    const world = buildWorld(
      slots([["o1", 0, 0], ["o2", 1, 0], ["o3", 2, 0]]),
      SEED,
      stations([["o1", ["a", "b"]], ["o2", ["c", "d"]], ["o3", ["e", "f"]]]),
    );
    const fitZoom = Math.min(VIEWPORT_W / world.width, VIEWPORT_H / world.height);
    expect(fitZoom).toBeLessThan(1.0);
  });
});

describe("allocateDemoSlots — compact append-only allocator", () => {
  it("1 owner: single sector at (0,0)", () => {
    const slots = allocateDemoSlots(1);
    expect(slots).toHaveLength(1);
    expect(slots[0].gridX).toBe(0);
    expect(slots[0].gridY).toBe(0);
  });

  it("3 owners: prefix of 8, existing positions unchanged", () => {
    const s3 = allocateDemoSlots(3);
    const s8 = allocateDemoSlots(8);
    for (let i = 0; i < 3; i++) {
      expect(s8[i].gridX).toBe(s3[i].gridX);
      expect(s8[i].gridY).toBe(s3[i].gridY);
      expect(s8[i].ownerUid).toBe(s3[i].ownerUid);
    }
  });

  it("8 → 24 → 64: each is a prefix of the next", () => {
    const s8 = allocateDemoSlots(8);
    const s24 = allocateDemoSlots(24);
    const s64 = allocateDemoSlots(64);
    for (let i = 0; i < 8; i++) {
      expect(s24[i].gridX).toBe(s8[i].gridX);
      expect(s24[i].gridY).toBe(s8[i].gridY);
    }
    for (let i = 0; i < 24; i++) {
      expect(s64[i].gridX).toBe(s24[i].gridX);
      expect(s64[i].gridY).toBe(s24[i].gridY);
    }
  });

  it("no collisions in any allocation", () => {
    for (const count of [1, 3, 8, 24, 64]) {
      const s = allocateDemoSlots(count);
      const keys = new Set(s.map((x) => `${x.gridX},${x.gridY}`));
      expect(keys.size).toBe(count);
    }
  });

  it("all coordinates are non-negative integers", () => {
    const s = allocateDemoSlots(64);
    for (const slot of s) {
      expect(Number.isInteger(slot.gridX)).toBe(true);
      expect(Number.isInteger(slot.gridY)).toBe(true);
      expect(slot.gridX).toBeGreaterThanOrEqual(0);
      expect(slot.gridY).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects negative count", () => {
    expect(() => allocateDemoSlots(-1)).toThrow(WorldError);
  });

  it("rejects non-integer count", () => {
    expect(() => allocateDemoSlots(2.5)).toThrow(WorldError);
  });

  it("demo slots produce a valid world (1/3/8/24/64)", () => {
    for (const count of [1, 3, 8, 24, 64]) {
      const s = allocateDemoSlots(count);
      const world = buildWorld(s, SEED, new Map(s.map((x) => [x.ownerUid, ["drone-1"]] as [string, string[]])));
      expect(world.sectors).toHaveLength(count);
      // No overlapping sectors.
      for (let i = 0; i < world.sectors.length; i++) {
        for (let j = i + 1; j < world.sectors.length; j++) {
          const a = world.sectors[i], b = world.sectors[j];
          const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
          const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlapX && overlapY).toBe(false);
        }
      }
    }
  });
});
