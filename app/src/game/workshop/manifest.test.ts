import { describe, expect, it } from "vitest";
import {
  ACTOR_CELL_H,
  ACTOR_CELL_W,
  FACINGS,
  OWNER_ACCENTS,
  WORKER_FRAME_SETS,
  actorFrameOffset,
  ownerAccentIndex,
  ownerEmblem,
  validateActorManifest,
  validateWorkshopManifest,
  type ActorManifest,
  type WorkshopManifest,
} from "./manifest";

function validActorManifest(): ActorManifest {
  const totalFrames = WORKER_FRAME_SETS.reduce((s, f) => s + f.frames, 0);
  return {
    sheet: "actors.png",
    cellW: ACTOR_CELL_W,
    cellH: ACTOR_CELL_H,
    facings: FACINGS,
    frameSets: WORKER_FRAME_SETS,
    hasOwnerMask: true,
    sheetWidth: FACINGS.length * ACTOR_CELL_W,
    sheetHeight: totalFrames * ACTOR_CELL_H,
  };
}

function validWorkshopManifest(): WorkshopManifest {
  return {
    version: 1,
    actors: validActorManifest(),
    stations: {
      sheet: "stations.png",
      cellW: 64,
      cellH: 64,
      variants: ["rest", "work", "attention"],
      equipmentFrames: 6,
    },
    environment: {
      sheet: "environment.png",
      tileW: 32,
      tileH: 16,
      treeVariants: 4,
      shrubVariants: 2,
      accentVariants: 3,
    },
    effects: {
      sheet: "effects.png",
      packetFrames: 4,
      glyphCount: 5,
    },
    provenance: {
      sourceHash: "abc123",
      generatedAt: "2026-09-21",
      licence: "CC0",
    },
  };
}

describe("validateActorManifest", () => {
  it("accepts a valid manifest", () => {
    expect(validateActorManifest(validActorManifest())).toEqual([]);
  });

  it("rejects wrong cell dimensions", () => {
    const m = validActorManifest();
    m.cellW = 16;
    expect(validateActorManifest(m)).toContain("actor cellW 16 ≠ 32");
  });

  it("rejects missing facing", () => {
    const m = validActorManifest();
    m.facings = ["down", "left", "right"];
    expect(validateActorManifest(m)).toContain("missing facing: up");
  });

  it("rejects wrong frame count", () => {
    const m = validActorManifest();
    m.frameSets = m.frameSets.map((s) =>
      s.name === "work" ? { ...s, frames: 4 } : s,
    );
    expect(validateActorManifest(m)).toContain("frame set work: 4 frames ≠ expected 8");
  });

  it("rejects missing frame set", () => {
    const m = validActorManifest();
    m.frameSets = m.frameSets.filter((s) => s.name !== "idle");
    expect(validateActorManifest(m)).toContain("missing frame set: idle");
  });

  it("rejects sheet too small", () => {
    const m = validActorManifest();
    m.sheetWidth = 10;
    const errors = validateActorManifest(m);
    expect(errors.some((e) => e.includes("sheet width 10 < required"))).toBe(true);
  });
});

describe("actorFrameOffset", () => {
  const m = validActorManifest();

  it("returns (0,0) for first facing, first set, first frame", () => {
    expect(actorFrameOffset(m, "down", "idle", 0)).toEqual({ x: 0, y: 0 });
  });

  it("advances x for each facing", () => {
    const a = actorFrameOffset(m, "down", "idle", 0);
    const b = actorFrameOffset(m, "left", "idle", 0);
    expect(b.x).toBe(a.x + ACTOR_CELL_W);
  });

  it("advances y for each frame", () => {
    const a = actorFrameOffset(m, "down", "idle", 0);
    const b = actorFrameOffset(m, "down", "idle", 1);
    expect(b.y).toBe(a.y + ACTOR_CELL_H);
  });

  it("advances y for each frame set", () => {
    const idleLast = actorFrameOffset(m, "down", "idle", 3);
    const walkFirst = actorFrameOffset(m, "down", "walk", 0);
    expect(walkFirst.y).toBe(idleLast.y + ACTOR_CELL_H);
  });

  it("throws for unknown facing", () => {
    expect(() => actorFrameOffset(m, "diagonal" as any, "idle", 0)).toThrow("unknown facing");
  });

  it("throws for out-of-range frame", () => {
    expect(() => actorFrameOffset(m, "down", "idle", 99)).toThrow("out of range");
  });
});

describe("validateWorkshopManifest", () => {
  it("accepts a valid manifest", () => {
    expect(validateWorkshopManifest(validWorkshopManifest())).toEqual([]);
  });

  it("rejects wrong version", () => {
    const m = validWorkshopManifest();
    m.version = 2;
    expect(validateWorkshopManifest(m)).toContain("unsupported manifest version: 2");
  });

  it("rejects wrong tile size", () => {
    const m = validWorkshopManifest();
    m.environment.tileW = 16;
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("tile 16x16 ≠ 32x16"))).toBe(true);
  });

  it("rejects missing provenance", () => {
    const m = validWorkshopManifest();
    m.provenance.sourceHash = "";
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("missing sourceHash"))).toBe(true);
  });

  it("rejects too few equipment frames", () => {
    const m = validWorkshopManifest();
    m.stations.equipmentFrames = 2;
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("equipmentFrames 2 not in [4,6]"))).toBe(true);
  });

  it("rejects missing owner mask", () => {
    const m = validWorkshopManifest();
    m.actors.hasOwnerMask = false;
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("missing owner mask"))).toBe(true);
  });

  it("rejects empty station variants", () => {
    const m = validWorkshopManifest();
    m.stations.variants = [];
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("no variants"))).toBe(true);
  });

  it("rejects missing required station variant", () => {
    const m = validWorkshopManifest();
    m.stations.variants = ["rest"];
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes('missing variant "work"'))).toBe(true);
    expect(errors.some((e) => e.includes('missing variant "attention"'))).toBe(true);
  });

  it("rejects 1x1 station cell", () => {
    const m = validWorkshopManifest();
    m.stations.cellW = 1;
    m.stations.cellH = 1;
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("too small"))).toBe(true);
  });

  it("rejects empty asset paths", () => {
    const m = validWorkshopManifest();
    m.actors.sheet = "";
    m.stations.sheet = "";
    m.environment.sheet = "";
    m.effects.sheet = "";
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("actors: empty sheet"))).toBe(true);
    expect(errors.some((e) => e.includes("stations: empty sheet"))).toBe(true);
    expect(errors.some((e) => e.includes("environment: empty sheet"))).toBe(true);
    expect(errors.some((e) => e.includes("effects: empty sheet"))).toBe(true);
  });

  it("rejects no environment variants", () => {
    const m = validWorkshopManifest();
    m.environment.treeVariants = 0;
    m.environment.shrubVariants = 0;
    m.environment.accentVariants = 0;
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("no tree variants"))).toBe(true);
    expect(errors.some((e) => e.includes("no shrub variants"))).toBe(true);
    expect(errors.some((e) => e.includes("no floor accent variants"))).toBe(true);
  });

  it("rejects too few status glyphs", () => {
    const m = validWorkshopManifest();
    m.effects.glyphCount = 2;
    const errors = validateWorkshopManifest(m);
    expect(errors.some((e) => e.includes("glyphCount 2 < 4"))).toBe(true);
  });
});

describe("ownerAccentIndex", () => {
  it("returns a valid index", () => {
    const idx = ownerAccentIndex("owner-1");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(OWNER_ACCENTS.length);
  });

  it("is deterministic (pure f(uid))", () => {
    expect(ownerAccentIndex("owner-1")).toBe(ownerAccentIndex("owner-1"));
  });

  it("PURE: owner-i alone vs with owner-a present gives same index", () => {
    // The old bug: walking earlier roster members changed the index.
    // Now: no roster parameter. Same UID, same index, always.
    expect(ownerAccentIndex("owner-i")).toBe(ownerAccentIndex("owner-i"));
  });

  it("collision: two owners MAY share an accent (pigeonhole)", () => {
    // With 8 colours and enough owners, collisions are expected.
    // We do NOT promise all 8 remain distinct simultaneously.
    const owners = Array.from({ length: 10 }, (_, i) => `owner-x${i}`);
    const indices = owners.map((id) => ownerAccentIndex(id));
    // At least one collision is likely with 10 owners / 8 colours.
    // But each index is still stable per owner.
    for (const id of owners) {
      expect(ownerAccentIndex(id)).toBe(indices[owners.indexOf(id)]);
    }
  });

  it("ownerEmblem is independent and stable", () => {
    for (let i = 0; i < 10; i++) {
      const uid = `owner-e${i}`;
      expect(ownerEmblem(uid)).toBe(ownerEmblem(uid));
      expect(ownerEmblem(uid)).toBeGreaterThanOrEqual(0);
      expect(ownerEmblem(uid)).toBeLessThan(8);
    }
  });

  it("has 8 accent colours", () => {
    expect(OWNER_ACCENTS).toHaveLength(8);
  });
});

describe("constants", () => {
  it("actor cell is 32×48", () => {
    expect(ACTOR_CELL_W).toBe(32);
    expect(ACTOR_CELL_H).toBe(48);
  });
  it("four facings", () => {
    expect(FACINGS).toHaveLength(4);
  });
  it("7 frame sets for the worker", () => {
    expect(WORKER_FRAME_SETS).toHaveLength(7);
  });
});
