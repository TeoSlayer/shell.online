/**
 * Workshop layout: stable station slots, owner clearings, and pagination.
 *
 * Pure logic — no Pixi, no DOM. Takes bounded station IDs and dimensions,
 * returns deterministic screen positions. The renderer consumes these;
 * it does not invent its own placement.
 *
 * Scene target: 480×270 logical pixels, integer-scaled (4× at 1080p, 8× at 4K).
 * Ground tile: 32×16. Actor cell: 32×48. Workstation cell: 64×64.
 * Safe area: 5% inset. Status strip: 16px at top (scene coords).
 */

export const SCENE_W = 480;
export const SCENE_H = 270;

export const SAFE_INSET_X = Math.round(SCENE_W * 0.05); // 24
export const SAFE_INSET_Y = Math.round(SCENE_H * 0.05); // 14
export const STATUS_STRIP_H = 16;

/** Usable content area (inside safe area, below status strip). */
export const CONTENT_X = SAFE_INSET_X;
export const CONTENT_Y = SAFE_INSET_Y + STATUS_STRIP_H;
export const CONTENT_W = SCENE_W - 2 * SAFE_INSET_X; // 432
export const CONTENT_H = SCENE_H - 2 * SAFE_INSET_Y - STATUS_STRIP_H; // 226

export const STATION_W = 64;
export const STATION_H = 64;
export const AISLE = 32;
export const OWNER_W = 32;
export const OWNER_H = 48;

/** Maximum workers visible per clearing/page. */
export const MAX_PER_PAGE = 8;
/** Minimum workers that fit comfortably. */
export const MIN_PER_PAGE = 3;

export interface StationSlot {
  /** Stable station ID (session ID or alias). */
  id: string;
  /** Top-left of the 64×64 workstation cell in scene coords. */
  x: number;
  y: number;
  /** Centre-bottom of the 32×48 actor cell (foot anchor). */
  actorX: number;
  actorY: number;
  /** Depth sort key (y * 1000 + x). */
  depth: number;
}

export interface OwnerSlot {
  x: number;
  y: number;
  depth: number;
}

export interface ClearingLayout {
  owner: OwnerSlot;
  stations: StationSlot[];
  /** Total pages needed for the full roster. */
  totalPages: number;
  /** Current page (0-indexed). */
  page: number;
  /** Total stations in the full roster. */
  totalStations: number;
}

/**
 * Deterministic hash for stable ordering. The same set of IDs always
 * produces the same order, regardless of the order they were supplied in.
 */
export function stableOrder(ids: string[]): string[] {
  return [...ids].sort();
}

/**
 * Compute the number of pages needed for a roster.
 * Pages hold at most MAX_PER_PAGE workers. The last page may be smaller.
 */
export function pageCount(total: number): number {
  if (total <= 0) return 0;
  return Math.ceil(total / MAX_PER_PAGE);
}

/**
 * Select the IDs for a given page (0-indexed).
 */
export function pageIds(orderedIds: string[], page: number): string[] {
  const start = page * MAX_PER_PAGE;
  return orderedIds.slice(start, start + MAX_PER_PAGE);
}

/**
 * Lay out a single clearing: one owner marker and up to MAX_PER_PAGE stations.
 *
 * Layout strategy:
 * - Stations are arranged in rows of at most 4 (4*64 + 3*32 = 352px < 432px content width).
 * - Rows are stacked vertically with AISLE gap.
 * - The owner marker is placed to the left of the first row, vertically centred.
 * - Everything is centred within the content area.
 *
 * Deterministic: the same set of IDs always produces the same positions.
 */
export function layoutClearing(stationIds: string[], page = 0, totalStations = stationIds.length): ClearingLayout {
  const ordered = stableOrder(stationIds);
  const visible = pageIds(ordered, page);
  const pages = pageCount(totalStations);

  const owner: OwnerSlot = { x: 0, y: 0, depth: 0 };
  const stations: StationSlot[] = [];

  if (visible.length === 0) {
    // Empty clearing: owner at centre, no stations.
    owner.x = SCENE_W / 2 - OWNER_W / 2;
    owner.y = CONTENT_Y + CONTENT_H / 2 - OWNER_H / 2;
    owner.depth = owner.y * 1000 + owner.x;
    return { owner, stations, totalPages: pages, page, totalStations };
  }

  // Arrange stations in rows of at most 4.
  const PER_ROW = 4;
  const rows: string[][] = [];
  for (let i = 0; i < visible.length; i += PER_ROW) {
    rows.push(visible.slice(i, i + PER_ROW));
  }

  const rowWidth = (count: number) => count * STATION_W + (count - 1) * AISLE;
  const totalHeight = rows.length * STATION_H + (rows.length - 1) * AISLE;

  // Centre the block within the content area.
  const blockW = Math.max(...rows.map((r) => rowWidth(r.length)));
  const blockX = CONTENT_X + (CONTENT_W - blockW) / 2;
  const blockY = CONTENT_Y + (CONTENT_H - totalHeight) / 2;

  // Place each row.
  let y = blockY;
  for (const row of rows) {
    const w = rowWidth(row.length);
    let x = blockX + (blockW - w) / 2; // centre each row within the block
    for (const id of row) {
      const actorX = x + STATION_W / 2;
      const actorY = y + STATION_H - 4; // foot anchor: near bottom of cell
      stations.push({
        id,
        x,
        y,
        actorX,
        actorY,
        depth: actorY * 1000 + actorX,
      });
      x += STATION_W + AISLE;
    }
    y += STATION_H + AISLE;
  }

  // Owner: to the left of the first row, vertically centred on the block.
  const firstRowY = blockY;
  owner.x = blockX - OWNER_W - AISLE / 2;
  owner.y = firstRowY + (STATION_H - OWNER_H) / 2;
  // Clamp to content area.
  if (owner.x < CONTENT_X) owner.x = CONTENT_X;
  owner.depth = owner.y * 1000 + owner.x;

  return { owner, stations, totalPages: pages, page, totalStations };
}

/**
 * Check that no two station cells overlap. Returns pairs of overlapping IDs.
 */
export function stationCollisions(stations: StationSlot[]): [string, string][] {
  const collisions: [string, string][] = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i];
      const b = stations[j];
      const overlapX = a.x < b.x + STATION_W && b.x < a.x + STATION_W;
      const overlapY = a.y < b.y + STATION_H && b.y < a.y + STATION_H;
      if (overlapX && overlapY) {
        collisions.push([a.id, b.id]);
      }
    }
  }
  return collisions;
}

/**
 * Verify all stations are within the content area.
 */
export function outOfBounds(stations: StationSlot[]): string[] {
  return stations
    .filter(
      (s) =>
        s.x < CONTENT_X ||
        s.x + STATION_W > CONTENT_X + CONTENT_W ||
        s.y < CONTENT_Y ||
        s.y + STATION_H > CONTENT_Y + CONTENT_H,
    )
    .map((s) => s.id);
}
