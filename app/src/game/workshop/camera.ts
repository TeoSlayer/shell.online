/**
 * Workshop camera: deterministic pan/zoom within the world.
 *
 * The camera is a viewport (480×270) into a larger world. It supports:
 * - fit-all: zoom out to see all sectors
 * - focus-owner: zoom in on one owner's sector
 * - pan: move the camera to a specific world position
 *
 * No auto-pan, no wandering. The camera stays where the user puts it.
 * Labels are only rendered when the zoom level is high enough to read them.
 *
 * All functions validate finite inputs. Zoom is clamped BEFORE computing
 * the viewport origin, so the centre point is always correct.
 */
import { VIEWPORT_H, VIEWPORT_W, type WorkshopWorld } from "./world";

export interface CameraState {
  /** World position of the viewport's top-left corner. */
  x: number;
  y: number;
  /** Zoom level. 1.0 = 1:1 (viewport = 480×270 world units). */
  zoom: number;
}

/** Minimum zoom floor (used when no world is provided). */
const DEFAULT_MIN_ZOOM = 0.1;

/** Maximum zoom: 1:1 (no further zoom in). */
export const MAX_ZOOM = 1.0;

/**
 * Zoom level at which labels become readable.
 * At 1:1, a 9px font is 9px. At 0.5x, it's 4.5px (unreadable on TV).
 * Labels are shown when zoom >= LABEL_ZOOM_THRESHOLD.
 */
export const LABEL_ZOOM_THRESHOLD = 0.4;

/**
 * Minimum zoom: see the entire world.
 */
export function minZoom(world: WorkshopWorld): number {
  return Math.min(VIEWPORT_W / world.width, VIEWPORT_H / world.height);
}

/**
 * Clamp a zoom level to the valid range for the world.
 * Rejects non-finite input.
 */
export function clampZoom(zoom: number, world?: WorkshopWorld): number {
  if (!Number.isFinite(zoom)) {
    throw new Error(`clampZoom: zoom must be finite, got ${zoom}`);
  }
  const min = world ? minZoom(world) : DEFAULT_MIN_ZOOM;
  return Math.max(min, Math.min(MAX_ZOOM, zoom));
}

/**
 * Compute the camera state to fit the entire world in the viewport.
 * Pure function of world. Deterministic. No time dependency.
 */
export function fitAll(world: WorkshopWorld): CameraState {
  const zoom = minZoom(world);
  // Centre the world in the viewport.
  const x = (world.width - VIEWPORT_W / zoom) / 2;
  const y = (world.height - VIEWPORT_H / zoom) / 2;
  return { x, y, zoom };
}

/**
 * Compute the camera state to focus on a specific world region.
 * The region is centred in the viewport at the given zoom.
 *
 * Zoom is clamped FIRST, then the origin is computed from the clamped zoom.
 * This ensures the target point is always at the viewport centre.
 */
export function focusRegion(cx: number, cy: number, zoom: number): CameraState {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    throw new Error(`focusRegion: centre must be finite, got (${cx}, ${cy})`);
  }
  const effectiveZoom = clampZoom(zoom);
  const x = cx - VIEWPORT_W / effectiveZoom / 2;
  const y = cy - VIEWPORT_H / effectiveZoom / 2;
  return { x, y, zoom: effectiveZoom };
}

/**
 * Compute the camera state to focus on an owner's sector.
 */
export function focusOwner(world: WorkshopWorld, ownerUid: string): CameraState | null {
  const sector = world.sectors.find((s) => s.ownerUid === ownerUid);
  if (!sector) return null;
  const cx = sector.x + sector.w / 2;
  const cy = sector.y + sector.h / 2;
  const zoom = Math.min(
    (VIEWPORT_W * 0.8) / sector.w,
    (VIEWPORT_H * 0.8) / sector.h,
    MAX_ZOOM,
  );
  return focusRegion(cx, cy, zoom);
}

/**
 * Clamp a camera position so the viewport stays within the world bounds.
 *
 * When the viewport is LARGER than the world on an axis, the world is
 * centred in the viewport (negative offset preserved). This prevents
 * fit-all from jumping on the next pan/clamp.
 */
export function clampPosition(cam: CameraState, world: WorkshopWorld): CameraState {
  const viewW = VIEWPORT_W / cam.zoom;
  const viewH = VIEWPORT_H / cam.zoom;

  let x: number;
  let y: number;

  if (viewW >= world.width) {
    // Viewport wider than world: centre the world.
    x = (world.width - viewW) / 2;
  } else {
    x = Math.max(0, Math.min(world.width - viewW, cam.x));
  }

  if (viewH >= world.height) {
    // Viewport taller than world: centre the world.
    y = (world.height - viewH) / 2;
  } else {
    y = Math.max(0, Math.min(world.height - viewH, cam.y));
  }

  return { ...cam, x, y };
}

/**
 * Whether labels should be rendered at the current zoom level.
 * At low zoom (fit-all), labels are too small to read on TV.
 */
export function labelsVisible(zoom: number): boolean {
  return zoom >= LABEL_ZOOM_THRESHOLD;
}

/**
 * Pan the camera to a specific world position (centre of viewport).
 * Does not change zoom.
 */
export function panTo(cam: CameraState, worldX: number, worldY: number): CameraState {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
    throw new Error(`panTo: target must be finite, got (${worldX}, ${worldY})`);
  }
  const x = worldX - VIEWPORT_W / cam.zoom / 2;
  const y = worldY - VIEWPORT_H / cam.zoom / 2;
  return { ...cam, x, y };
}

/**
 * Convert a world coordinate to viewport (screen) coordinates.
 */
export function worldToScreen(cam: CameraState, worldX: number, worldY: number): { x: number; y: number } {
  return {
    x: (worldX - cam.x) * cam.zoom,
    y: (worldY - cam.y) * cam.zoom,
  };
}

/**
 * Convert a viewport (screen) coordinate to world coordinates.
 */
export function screenToWorld(cam: CameraState, screenX: number, screenY: number): { x: number; y: number } {
  return {
    x: screenX / cam.zoom + cam.x,
    y: screenY / cam.zoom + cam.y,
  };
}
