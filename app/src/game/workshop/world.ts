/**
 * Workshop world: programmatic grid-sector layout.
 *
 * The world is a grid of SECTORS. Each sector is allocated by the canonical
 * service as an explicit (gridX, gridY) slot. This module consumes those slot
 * records plus a worldSeed and produces a deterministic world.
 *
 * Key invariants:
 * - 480×270 is the CAMERA VIEWPORT, not the world extent.
 * - The world grows with the team: more sectors → larger grid → larger world.
 * - Slots are append-only: existing sectors never move when new ones are added.
 * - Layout does NOT recompute slots from the visible/sorted/filtered roster.
 * - Hidden/restricted owners' sectors are not rendered but do not shift others.
 * - Deterministic: same slots + seed → same world, every time.
 * - Rejects collisions, malformed input, and out-of-bounds coordinates.
 * - Props and sectors share the same world origin (FOREST_PAD offset).
 * - Paths between adjacent sectors have nonzero length.
 * - Stations are capped per sector (demo capacity).
 *
 * Pure logic — no Pixi, no DOM, no HTTP, no randomness.
 */

/** Camera viewport (what the user sees). NOT the world size. */
export const VIEWPORT_W = 480;
export const VIEWPORT_H = 270;

/** One grid sector. Large enough for a full clearing (8 stations + owner). */
export const SECTOR_W = 480;
export const SECTOR_H = 270;

/** Forest border thickness around the occupied grid. */
const FOREST_PAD = 64;

/** Gap between adjacent sectors (walkway corridor). */
const PATH_GAP = 32;

/** Station cell dimensions (fixed drone/station size). */
const STATION_W = 64;
const STATION_H = 64;
const AISLE = 32;

/** Maximum grid dimension (caps prop loops and world extent). */
export const MAX_GRID = 128;

/** Maximum stations per sector (demo capacity; overflow sectors TBD). */
export const MAX_STATIONS_PER_SECTOR = 8;

/** An explicit sector slot allocated by the canonical service. */
export interface SectorSlot {
  ownerUid: string;
  /** Grid column (0-indexed). */
  gridX: number;
  /** Grid row (0-indexed). */
  gridY: number;
}

export interface StationSlot {
  id: string;
  /** World coordinates (top-left of 64×64 station cell). */
  x: number;
  y: number;
  /** Foot anchor (world coords). */
  actorX: number;
  actorY: number;
  depth: number;
}

export interface Sector {
  ownerUid: string;
  gridX: number;
  gridY: number;
  /** World position of the sector's top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  stations: StationSlot[];
}

/** A deterministic path between two adjacent sectors. Always nonzero length. */
export interface Path {
  from: string;
  to: string;
  x1: number; y1: number;
  x2: number; y2: number;
}

/** A deterministic forest/prop placement from the worldSeed. */
export interface Prop {
  type: "tree" | "shrub" | "accent";
  x: number;
  y: number;
  variant: number;
}

export interface WorkshopWorld {
  width: number;
  height: number;
  sectors: Sector[];
  paths: Path[];
  props: Prop[];
  /** Grid dimensions of the occupied area. */
  gridCols: number;
  gridRows: number;
}

export class WorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldError";
  }
}

/**
 * Validate sector slots. Rejects collisions, malformed input, and out-of-bounds
 * coordinates that would cause unbounded prop loops.
 */
function validateSlots(slots: SectorSlot[]): void {
  const seen = new Map<string, SectorSlot>();
  for (const slot of slots) {
    if (typeof slot.ownerUid !== "string" || slot.ownerUid.length === 0) {
      throw new WorldError("ownerUid must be a non-empty string");
    }
    if (!Number.isInteger(slot.gridX) || slot.gridX < 0 || slot.gridX >= MAX_GRID) {
      throw new WorldError(`invalid gridX for ${slot.ownerUid}: ${slot.gridX} (must be 0..${MAX_GRID - 1})`);
    }
    if (!Number.isInteger(slot.gridY) || slot.gridY < 0 || slot.gridY >= MAX_GRID) {
      throw new WorldError(`invalid gridY for ${slot.ownerUid}: ${slot.gridY} (must be 0..${MAX_GRID - 1})`);
    }
    const key = `${slot.gridX},${slot.gridY}`;
    if (seen.has(key)) {
      throw new WorldError(
        `sector collision at (${slot.gridX},${slot.gridY}): ${seen.get(key)!.ownerUid} and ${slot.ownerUid}`,
      );
    }
    seen.set(key, slot);
  }
}

/**
 * Validate the world seed. Must be a finite number.
 * Normalizes via |Math.trunc(seed)| so negative/fractional seeds are stable.
 * NaN and Infinity are rejected (not silently treated as 0).
 */
function validateSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new WorldError(`worldSeed must be a finite number, got ${seed}`);
  }
  return Math.abs(Math.trunc(seed));
}

/**
 * Deterministic hash for prop placement. Pure function of seed + position.
 */
function hash2d(seed: number, x: number, y: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h = Math.imul(h ^ y, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return Math.abs(h);
}

/**
 * Generate deterministic forest/prop placements for the world border and
 * inter-sector gaps. Pure function of the seed and world dimensions.
 *
 * Props use the SAME world origin as sectors (FOREST_PAD offset), so a
 * one-sector world has all props in positive coordinates within the world.
 */
function generateProps(seed: number, gridCols: number, gridRows: number): Prop[] {
  const props: Prop[] = [];
  const gridW = gridCols * SECTOR_W + (gridCols - 1) * PATH_GAP;
  const gridH = gridRows * SECTOR_H + (gridRows - 1) * PATH_GAP;

  // Forest border: trees around the perimeter (in world coords, with FOREST_PAD).
  const treeSpacing = 48;
  // Top and bottom borders (inside the forest padding).
  for (let x = 0; x < gridW; x += treeSpacing) {
    const v = hash2d(seed, x, 0) % 4;
    props.push({ type: "tree", x: x + FOREST_PAD, y: FOREST_PAD / 2, variant: v });
    props.push({ type: "tree", x: x + FOREST_PAD, y: gridH + FOREST_PAD * 1.5, variant: (v + 1) % 4 });
  }
  // Left and right borders.
  for (let y = 0; y < gridH; y += treeSpacing) {
    const v = hash2d(seed, 0, y) % 4;
    props.push({ type: "tree", x: FOREST_PAD / 2, y: y + FOREST_PAD, variant: v });
    props.push({ type: "tree", x: gridW + FOREST_PAD * 1.5, y: y + FOREST_PAD, variant: (v + 2) % 4 });
  }
  // Shrub accents in inter-sector gaps (deterministic from seed, same origin).
  for (let gx = 0; gx < gridCols - 1; gx++) {
    for (let gy = 0; gy < gridRows; gy++) {
      const h = hash2d(seed, gx * 7 + 1, gy * 13 + 3);
      if (h % 5 === 0) {
        props.push({
          type: "shrub",
          x: (gx + 1) * (SECTOR_W + PATH_GAP) + FOREST_PAD - PATH_GAP / 2,
          y: gy * (SECTOR_H + PATH_GAP) + FOREST_PAD + (h % SECTOR_H),
          variant: h % 3,
        });
      }
    }
  }
  return props;
}

/**
 * Build the workshop world from explicit sector slots and a seed.
 *
 * @param slots - sector allocations from the canonical service (append-only)
 * @param worldSeed - deterministic seed for prop placement (must be finite)
 * @param stationsByOwner - station IDs per owner (capped at MAX_STATIONS_PER_SECTOR)
 */
export function buildWorld(
  slots: SectorSlot[],
  worldSeed: number,
  stationsByOwner: Map<string, string[]>,
): WorkshopWorld {
  validateSlots(slots);
  const seed = validateSeed(worldSeed);

  if (slots.length === 0) {
    return {
      width: VIEWPORT_W, height: VIEWPORT_H,
      sectors: [], paths: [], props: [],
      gridCols: 1, gridRows: 1,
    };
  }

  // Grid dimensions from occupied slots.
  const maxGX = Math.max(...slots.map((s) => s.gridX));
  const maxGY = Math.max(...slots.map((s) => s.gridY));
  const gridCols = maxGX + 1;
  const gridRows = maxGY + 1;

  // World dimensions: grid (with gaps) + forest border.
  const worldW = gridCols * SECTOR_W + (gridCols - 1) * PATH_GAP + 2 * FOREST_PAD;
  const worldH = gridRows * SECTOR_H + (gridRows - 1) * PATH_GAP + 2 * FOREST_PAD;

  // Build sectors.
  const sectors: Sector[] = [];
  for (const slot of slots) {
    const sx = slot.gridX * (SECTOR_W + PATH_GAP) + FOREST_PAD;
    const sy = slot.gridY * (SECTOR_H + PATH_GAP) + FOREST_PAD;
    const stationIds = (stationsByOwner.get(slot.ownerUid) ?? []).slice(0, MAX_STATIONS_PER_SECTOR);
    const stations = layoutStations(stationIds, sx, sy);
    sectors.push({
      ownerUid: slot.ownerUid,
      gridX: slot.gridX,
      gridY: slot.gridY,
      x: sx, y: sy,
      w: SECTOR_W, h: SECTOR_H,
      stations,
    });
  }

  // Paths between adjacent occupied sectors.
  // Endpoints are the sector edges (right/bottom of one, left/top of the other).
  // The PATH_GAP between sectors ensures every path has nonzero length.
  const occupied = new Set(slots.map((s) => `${s.gridX},${s.gridY}`));
  const slotMap = new Map(slots.map((s) => [`${s.gridX},${s.gridY}`, s]));
  const paths: Path[] = [];
  for (const slot of slots) {
    // Right neighbour: path from right edge of this sector to left edge of neighbour.
    const rightKey = `${slot.gridX + 1},${slot.gridY}`;
    if (occupied.has(rightKey)) {
      const y = slot.gridY * (SECTOR_H + PATH_GAP) + FOREST_PAD + SECTOR_H / 2;
      paths.push({
        from: slot.ownerUid,
        to: slotMap.get(rightKey)!.ownerUid,
        x1: slot.gridX * (SECTOR_W + PATH_GAP) + FOREST_PAD + SECTOR_W,
        y1: y,
        x2: (slot.gridX + 1) * (SECTOR_W + PATH_GAP) + FOREST_PAD,
        y2: y,
      });
    }
    // Bottom neighbour: path from bottom edge of this sector to top edge of neighbour.
    const bottomKey = `${slot.gridX},${slot.gridY + 1}`;
    if (occupied.has(bottomKey)) {
      const x = slot.gridX * (SECTOR_W + PATH_GAP) + FOREST_PAD + SECTOR_W / 2;
      paths.push({
        from: slot.ownerUid,
        to: slotMap.get(bottomKey)!.ownerUid,
        x1: x,
        y1: slot.gridY * (SECTOR_H + PATH_GAP) + FOREST_PAD + SECTOR_H,
        x2: x,
        y2: (slot.gridY + 1) * (SECTOR_H + PATH_GAP) + FOREST_PAD,
      });
    }
  }

  // Deterministic props from seed.
  const props = generateProps(seed, gridCols, gridRows);

  return {
    width: worldW,
    height: worldH,
    sectors,
    paths,
    props,
    gridCols,
    gridRows,
  };
}

/**
 * Layout stations within a sector. Rows of at most 4, centred in the sector.
 * Input is already capped to MAX_STATIONS_PER_SECTOR by buildWorld.
 */
function layoutStations(ids: string[], sectorX: number, sectorY: number): StationSlot[] {
  const ordered = [...ids].sort();
  const PER_ROW = 4;
  const rows: string[][] = [];
  for (let i = 0; i < ordered.length; i += PER_ROW) {
    rows.push(ordered.slice(i, i + PER_ROW));
  }
  const rowW = (count: number) => count * STATION_W + (count - 1) * AISLE;
  const blockW = rows.length > 0 ? Math.max(...rows.map((r) => rowW(r.length))) : 0;
  const blockH = rows.length * STATION_H + (rows.length - 1) * AISLE;

  const stations: StationSlot[] = [];
  const offsetX = sectorX + (SECTOR_W - blockW) / 2;
  const offsetY = sectorY + (SECTOR_H - blockH) / 2;

  let y = offsetY;
  for (const row of rows) {
    let x = offsetX + (blockW - rowW(row.length)) / 2;
    for (const id of row) {
      const ax = x + STATION_W / 2;
      const ay = y + STATION_H - 4;
      stations.push({
        id, x, y,
        actorX: ax, actorY: ay,
        depth: ay * 1000 + ax,
      });
      x += STATION_W + AISLE;
    }
    y += STATION_H + AISLE;
  }
  return stations;
}

/**
 * Find the sector for a given owner.
 */
export function findSector(world: WorkshopWorld, ownerUid: string): Sector | undefined {
  return world.sectors.find((s) => s.ownerUid === ownerUid);
}

/**
 * Compute the bounding box of all sectors (for camera fit-all).
 */
export function worldBounds(world: WorkshopWorld): { x: number; y: number; w: number; h: number } {
  if (world.sectors.length === 0) return { x: 0, y: 0, w: VIEWPORT_W, h: VIEWPORT_H };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of world.sectors) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w);
    maxY = Math.max(maxY, s.y + s.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Compute which sectors are visible in the current camera viewport.
 * Used for bounded/chunk rendering: only render visible sectors.
 * Rejects zero-area or negative-area viewports (returns empty).
 */
export function visibleSectors(
  world: WorkshopWorld,
  camX: number,
  camY: number,
  camW: number,
  camH: number,
): Sector[] {
  if (camW <= 0 || camH <= 0) return [];
  return world.sectors.filter((s) =>
    s.x < camX + camW && s.x + s.w > camX &&
    s.y < camY + camH && s.y + s.h > camY,
  );
}

/**
 * Compact append-only demo allocator.
 *
 * Produces a deterministic square-ring allocation sequence:
 *   ring 0: (0,0)
 *   ring 1: (1,0), (1,1), (0,1), (0,0) — but (0,0) is taken, so (1,0),(1,1),(0,1)
 *   ring 2: (2,0),(2,1),(2,2),(1,2),(0,2)
 *   ring 3: (3,0),(3,1),(3,2),(3,3),(2,3),(1,3),(0,3)
 *   ...
 *
 * Every scenario (1, 3, 8, 24, 64) is a PREFIX of the next.
 * Existing owners never move. New owners fill the next ring.
 *
 * This is a demo allocator only — the canonical service handles production
 * allocation. No auth, no persistence, no service calls.
 */
export function allocateDemoSlots(count: number): SectorSlot[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_GRID * MAX_GRID) {
    throw new WorldError(`allocateDemoSlots: count must be 0..${MAX_GRID * MAX_GRID}, got ${count}`);
  }
  const slots: SectorSlot[] = [];
  // Square-ring allocation: ring r covers all cells where max(x,y) == r.
  // Ring 0: (0,0)
  // Ring r (r>=1): right edge (r,0)..(r,r), then bottom edge (0,r)..(r-1,r)
  // Every scenario (1,3,8,24,64) is a prefix of the next. No collisions.
  let assigned = 0;
  for (let ring = 0; ring < MAX_GRID && assigned < count; ring++) {
    if (ring === 0) {
      slots.push({ ownerUid: `demo-${assigned}`, gridX: 0, gridY: 0 });
      assigned++;
      continue;
    }
    // Right edge: (ring, 0) to (ring, ring) — r+1 cells.
    for (let y = 0; y <= ring && assigned < count; y++) {
      slots.push({ ownerUid: `demo-${assigned}`, gridX: ring, gridY: y });
      assigned++;
    }
    // Bottom edge: (0, ring) to (ring-1, ring) — r cells.
    for (let x = 0; x < ring && assigned < count; x++) {
      slots.push({ ownerUid: `demo-${assigned}`, gridX: x, gridY: ring });
      assigned++;
    }
  }
  return slots.slice(0, count);
}
