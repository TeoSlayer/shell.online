import { describe, expect, it } from "vitest";
import {
  CONTENT_H,
  CONTENT_W,
  CONTENT_X,
  CONTENT_Y,
  SCENE_H,
  SCENE_W,
  STATION_H,
  STATION_W,
  layoutClearing,
  outOfBounds,
  pageCount,
  pageIds,
  stableOrder,
  stationCollisions,
} from "./layout";

describe("workshop layout", () => {
  describe("stableOrder", () => {
    it("produces the same order regardless of input order", () => {
      const a = ["ses_c", "ses_a", "ses_b"];
      const b = ["ses_b", "ses_c", "ses_a"];
      expect(stableOrder(a)).toEqual(stableOrder(b));
    });

    it("returns a sorted copy", () => {
      const input = ["z", "a", "m"];
      const result = stableOrder(input);
      expect(result).toEqual(["a", "m", "z"]);
      expect(input).toEqual(["z", "a", "m"]);
    });
  });

  describe("pageCount", () => {
    it("returns 0 for empty roster", () => {
      expect(pageCount(0)).toBe(0);
    });
    it("returns 1 for up to MAX_PER_PAGE", () => {
      expect(pageCount(1)).toBe(1);
      expect(pageCount(3)).toBe(1);
      expect(pageCount(8)).toBe(1);
    });
    it("pages correctly for larger rosters", () => {
      expect(pageCount(9)).toBe(2);
      expect(pageCount(16)).toBe(2);
      expect(pageCount(17)).toBe(3);
      expect(pageCount(24)).toBe(3);
    });
  });

  describe("pageIds", () => {
    const ids = stableOrder(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"]);
    it("returns the first page (8 items)", () => {
      expect(pageIds(ids, 0)).toHaveLength(8);
      expect(pageIds(ids, 0)).toEqual(ids.slice(0, 8));
    });
    it("returns the second page (2 items)", () => {
      expect(pageIds(ids, 1)).toHaveLength(2);
      expect(pageIds(ids, 1)).toEqual(ids.slice(8, 10));
    });
    it("returns empty for out-of-range page", () => {
      expect(pageIds(ids, 5)).toEqual([]);
    });
  });

  describe("layoutClearing — 3 workers", () => {
    const ids = ["ses_alpha", "ses_beta", "ses_gamma"];
    it("places 3 stations", () => {
      const layout = layoutClearing(ids);
      expect(layout.stations).toHaveLength(3);
    });
    it("has no collisions", () => {
      const layout = layoutClearing(ids);
      expect(stationCollisions(layout.stations)).toEqual([]);
    });
    it("all stations are within bounds", () => {
      const layout = layoutClearing(ids);
      expect(outOfBounds(layout.stations)).toEqual([]);
    });
    it("is stable across reordered input", () => {
      const a = layoutClearing(ids);
      const b = layoutClearing([...ids].reverse());
      expect(a.stations.map((s) => [s.id, s.x, s.y])).toEqual(
        b.stations.map((s) => [s.id, s.x, s.y]),
      );
    });
    it("reports 1 page for 3 workers", () => {
      const layout = layoutClearing(ids);
      expect(layout.totalPages).toBe(1);
      expect(layout.page).toBe(0);
      expect(layout.totalStations).toBe(3);
    });
  });

  describe("layoutClearing — 8 workers (max per page)", () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    it("places all 8 stations", () => {
      const layout = layoutClearing(ids);
      expect(layout.stations).toHaveLength(8);
    });
    it("has no collisions", () => {
      const layout = layoutClearing(ids);
      expect(stationCollisions(layout.stations)).toEqual([]);
    });
    it("all stations are within bounds", () => {
      const layout = layoutClearing(ids);
      expect(outOfBounds(layout.stations)).toEqual([]);
    });
    it("uses 2 rows of 4", () => {
      const layout = layoutClearing(ids);
      const ys = new Set(layout.stations.map((s) => s.y));
      expect(ys.size).toBe(2);
    });
  });

  describe("layoutClearing — 24 workers (3 pages)", () => {
    const ids = Array.from({ length: 24 }, (_, i) => `w${String(i).padStart(2, "0")}`);
    it("reports 3 pages", () => {
      const layout = layoutClearing(ids, 0, 24);
      expect(layout.totalPages).toBe(3);
    });
    it("page 0 shows 8 workers", () => {
      const layout = layoutClearing(ids, 0, 24);
      expect(layout.stations).toHaveLength(8);
    });
    it("page 1 shows 8 workers", () => {
      const layout = layoutClearing(ids, 1, 24);
      expect(layout.stations).toHaveLength(8);
    });
    it("page 2 shows 8 workers", () => {
      const layout = layoutClearing(ids, 2, 24);
      expect(layout.stations).toHaveLength(8);
    });
    it("pages are disjoint", () => {
      const p0 = new Set(layoutClearing(ids, 0, 24).stations.map((s) => s.id));
      const p1 = new Set(layoutClearing(ids, 1, 24).stations.map((s) => s.id));
      const p2 = new Set(layoutClearing(ids, 2, 24).stations.map((s) => s.id));
      for (const a of p0) {
        expect(p1.has(a)).toBe(false);
        expect(p2.has(a)).toBe(false);
      }
      for (const a of p1) {
        expect(p2.has(a)).toBe(false);
      }
    });
    it("no collisions on any page", () => {
      for (let p = 0; p < 3; p++) {
        const layout = layoutClearing(ids, p, 24);
        expect(stationCollisions(layout.stations)).toEqual([]);
      }
    });
  });

  describe("layoutClearing — empty roster", () => {
    it("has no stations", () => {
      const layout = layoutClearing([]);
      expect(layout.stations).toHaveLength(0);
    });
    it("owner is centred", () => {
      const layout = layoutClearing([]);
      expect(layout.owner.x).toBeCloseTo(SCENE_W / 2 - 16, 0);
    });
    it("reports 0 pages", () => {
      const layout = layoutClearing([]);
      expect(layout.totalPages).toBe(0);
    });
  });

  describe("layoutClearing — 1 worker", () => {
    it("places 1 station", () => {
      const layout = layoutClearing(["solo"]);
      expect(layout.stations).toHaveLength(1);
    });
    it("station is within bounds", () => {
      const layout = layoutClearing(["solo"]);
      expect(outOfBounds(layout.stations)).toEqual([]);
    });
  });

  describe("depth ordering", () => {
    it("stations lower on screen have greater depth", () => {
      const layout = layoutClearing(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
      const sorted = [...layout.stations].sort((a, b) => a.depth - b.depth);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].actorY).toBeGreaterThanOrEqual(sorted[i - 1].actorY);
      }
    });
  });

  describe("content area constants", () => {
    it("safe area is 5% of scene", () => {
      expect(CONTENT_X).toBe(Math.round(SCENE_W * 0.05));
      expect(CONTENT_Y).toBe(Math.round(SCENE_H * 0.05) + 16);
    });
    it("content fits within scene", () => {
      expect(CONTENT_X + CONTENT_W).toBeLessThanOrEqual(SCENE_W);
      expect(CONTENT_Y + CONTENT_H).toBeLessThanOrEqual(SCENE_H);
    });
    it("station cell fits in content", () => {
      expect(STATION_W).toBeLessThanOrEqual(CONTENT_W);
      expect(STATION_H).toBeLessThanOrEqual(CONTENT_H);
    });
  });
});
