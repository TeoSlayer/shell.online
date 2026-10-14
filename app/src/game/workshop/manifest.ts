/**
 * Workshop asset manifest: validation and type definitions.
 *
 * Defines the expected sprite sheet layout for the workshop art:
 * - 32×48 actor cells, four facings
 * - Frame sets: idle 4, walk 6, work 8, read 6, receive 4, attention 4, halted 2
 * - Owner colour masks (separate layer, same registration)
 * - Workstation, environment, and effects sheets
 *
 * The manifest is validated at build time and at scene load. Mismatches
 * are errors, not silent fallbacks.
 */

export const ACTOR_CELL_W = 32;
export const ACTOR_CELL_H = 48;
export const FACINGS = ["down", "left", "right", "up"] as const;
export type Facing = (typeof FACINGS)[number];

export interface FrameSet {
  name: string;
  frames: number;
  /** Milliseconds per frame. */
  fps: number;
}

/** Required animation sets for the base worker. */
export const WORKER_FRAME_SETS: FrameSet[] = [
  { name: "idle", frames: 4, fps: 4 },
  { name: "walk", frames: 6, fps: 8 },
  { name: "work", frames: 8, fps: 8 },
  { name: "read", frames: 6, fps: 6 },
  { name: "receive", frames: 4, fps: 8 },
  { name: "attention", frames: 4, fps: 6 },
  { name: "halted", frames: 2, fps: 2 },
];

export interface ActorManifest {
  /** Sheet filename. */
  sheet: string;
  /** Cell dimensions. */
  cellW: number;
  cellH: number;
  /** Facings in order. */
  facings: readonly Facing[];
  /** Animation frame sets. */
  frameSets: FrameSet[];
  /** Whether an owner-mask layer is present. */
  hasOwnerMask: boolean;
  /** Total width of the sheet in pixels. */
  sheetWidth: number;
  /** Total height of the sheet in pixels. */
  sheetHeight: number;
}

export interface StationManifest {
  sheet: string;
  cellW: number;
  cellH: number;
  /** Rest/work/attention variants. */
  variants: string[];
  /** Equipment animation frames (4-6). */
  equipmentFrames: number;
}

export interface EnvironmentManifest {
  sheet: string;
  /** Ground tile dimensions. */
  tileW: number;
  tileH: number;
  /** Number of tree variants. */
  treeVariants: number;
  /** Number of shrub variants. */
  shrubVariants: number;
  /** Number of floor accent variants. */
  accentVariants: number;
}

export interface EffectsManifest {
  sheet: string;
  /** Message packet frames. */
  packetFrames: number;
  /** Status glyph count. */
  glyphCount: number;
}

export interface WorkshopManifest {
  version: number;
  actors: ActorManifest;
  stations: StationManifest;
  environment: EnvironmentManifest;
  effects: EffectsManifest;
  /** Provenance: source hash, generation date, licence. */
  provenance: {
    sourceHash: string;
    generatedAt: string;
    licence: string;
  };
}

/**
 * Validate an actor manifest against the production requirements.
 * Returns a list of errors (empty = valid).
 */
export function validateActorManifest(m: ActorManifest): string[] {
  const errors: string[] = [];
  if (m.cellW !== ACTOR_CELL_W) errors.push(`actor cellW ${m.cellW} ≠ ${ACTOR_CELL_W}`);
  if (m.cellH !== ACTOR_CELL_H) errors.push(`actor cellH ${m.cellH} ≠ ${ACTOR_CELL_H}`);
  if (m.facings.length !== FACINGS.length) errors.push(`expected ${FACINGS.length} facings, got ${m.facings.length}`);
  for (const f of FACINGS) {
    if (!m.facings.includes(f)) errors.push(`missing facing: ${f}`);
  }
  const requiredSets = new Set(WORKER_FRAME_SETS.map((s) => s.name));
  for (const s of m.frameSets) {
    if (!requiredSets.has(s.name)) errors.push(`unexpected frame set: ${s.name}`);
    requiredSets.delete(s.name);
  }
  for (const missing of requiredSets) {
    errors.push(`missing frame set: ${missing}`);
  }
  for (const s of WORKER_FRAME_SETS) {
    const found = m.frameSets.find((f) => f.name === s.name);
    if (found && found.frames !== s.frames) {
      errors.push(`frame set ${s.name}: ${found.frames} frames ≠ expected ${s.frames}`);
    }
  }
  // Sheet dimensions must accommodate all facings × all frames.
  const totalFrames = m.frameSets.reduce((sum, s) => sum + s.frames, 0);
  const minW = m.facings.length * m.cellW;
  const minH = totalFrames * m.cellH;
  if (m.sheetWidth < minW) errors.push(`sheet width ${m.sheetWidth} < required ${minW}`);
  if (m.sheetHeight < minH) errors.push(`sheet height ${m.sheetHeight} < required ${minH}`);
  return errors;
}

/**
 * Compute the pixel offset of a specific frame within the actor sheet.
 *
 * Layout: columns = facings (left to right), rows = frames (top to bottom),
 * grouped by frame set.
 */
export function actorFrameOffset(
  m: ActorManifest,
  facing: Facing,
  frameSetName: string,
  frameIndex: number,
): { x: number; y: number } {
  const facingIdx = m.facings.indexOf(facing);
  if (facingIdx < 0) throw new Error(`unknown facing: ${facing}`);
  const setIdx = m.frameSets.findIndex((s) => s.name === frameSetName);
  if (setIdx < 0) throw new Error(`unknown frame set: ${frameSetName}`);
  const set = m.frameSets[setIdx];
  if (frameIndex < 0 || frameIndex >= set.frames) {
    throw new Error(`frame ${frameIndex} out of range for ${frameSetName} (${set.frames})`);
  }
  // Rows are grouped by frame set, then by frame within the set.
  let rowOffset = 0;
  for (let i = 0; i < setIdx; i++) {
    rowOffset += m.frameSets[i].frames;
  }
  return {
    x: facingIdx * m.cellW,
    y: (rowOffset + frameIndex) * m.cellH,
  };
}

/**
 * Validate the full workshop manifest.
 * Requires: non-empty asset paths, owner mask, station variants,
 * environment variants, and frame coverage.
 */
export function validateWorkshopManifest(m: WorkshopManifest): string[] {
  const errors: string[] = [];
  if (m.version !== 1) errors.push(`unsupported manifest version: ${m.version}`);
  // Asset paths must be non-empty.
  if (!m.actors.sheet) errors.push("actors: empty sheet path");
  if (!m.stations.sheet) errors.push("stations: empty sheet path");
  if (!m.environment.sheet) errors.push("environment: empty sheet path");
  if (!m.effects.sheet) errors.push("effects: empty sheet path");
  errors.push(...validateActorManifest(m.actors).map((e) => `actors: ${e}`));
  // Owner mask is required for production (not optional in the final manifest).
  if (!m.actors.hasOwnerMask) errors.push("actors: missing owner mask layer");
  // Station variants must be non-empty and include required states.
  if (m.stations.variants.length === 0) errors.push("stations: no variants");
  for (const required of ["rest", "work", "attention"]) {
    if (!m.stations.variants.includes(required)) {
      errors.push(`stations: missing variant "${required}"`);
    }
  }
  if (m.stations.equipmentFrames < 4 || m.stations.equipmentFrames > 6) {
    errors.push(`stations: equipmentFrames ${m.stations.equipmentFrames} not in [4,6]`);
  }
  if (m.stations.cellW < 32 || m.stations.cellH < 32) {
    errors.push(`stations: cell ${m.stations.cellW}x${m.stations.cellH} too small (min 32x32)`);
  }
  // Environment variants must be non-empty.
  if (m.environment.treeVariants < 1) errors.push("environment: no tree variants");
  if (m.environment.shrubVariants < 1) errors.push("environment: no shrub variants");
  if (m.environment.accentVariants < 1) errors.push("environment: no floor accent variants");
  if (m.environment.tileW !== 32 || m.environment.tileH !== 16) {
    errors.push(`environment: tile ${m.environment.tileW}x${m.environment.tileH} ≠ 32x16`);
  }
  // Effects must have packet frames and glyphs.
  if (m.effects.packetFrames < 4) {
    errors.push(`effects: packetFrames ${m.effects.packetFrames} < 4`);
  }
  if (m.effects.glyphCount < 4) {
    errors.push(`effects: glyphCount ${m.effects.glyphCount} < 4 (need working/quiet/needs-input/offline/stale)`);
  }
  if (!m.provenance.sourceHash) errors.push("provenance: missing sourceHash");
  if (!m.provenance.licence) errors.push("provenance: missing licence");
  return errors;
}

/**
 * Owner accent palette (initial 8 colours).
 * Exact hex values are locked with the approved art sheet;
 * these are placeholders for layout/dev fixtures.
 */
export const OWNER_ACCENTS = [
  "#2dd4bf", // teal
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#3b82f6", // blue
  "#f97316", // coral
  "#84cc16", // lime
  "#f43f5e", // rose
  "#f8fafc", // ivory
] as const;

/** Stable owner→accent-index map. */
export type OwnerAccentMap = Map<string, number>;

/**
 * Deterministic hash for an owner UID. Same UID always gives the same hash.
 */
function hashOf(id: string): number {
  let value = 0;
  for (let i = 0; i < id.length; i++) {
    value = (value * 31 + id.charCodeAt(i)) | 0;
  }
  return value;
}

/**
 * Resolve an owner accent index. PURELY a function of the owner UID.
 * No roster parameter: the index never changes when other owners join or
 * leave. Two owners that hash to the same index share a colour and are
 * distinguished by a separately stable emblem (see ownerEmblem).
 *
 * We do NOT promise all eight colours remain distinct simultaneously —
 * a hash collision means two owners get the same colour.
 */
export function ownerAccentIndex(ownerUid: string): number {
  return Math.abs(hashOf(ownerUid)) % OWNER_ACCENTS.length;
}

/**
 * A separately stable emblem index for an owner. Used to distinguish owners
 * that share the same accent colour (hash collision). The emblem is a small
 * visual marker (e.g. a number or shape) rendered alongside the colour trim.
 *
 * Purely a function of the UID, independent of the accent index.
 */
export function ownerEmblem(ownerUid: string): number {
  // Use a different hash seed so the emblem is independent of the accent.
  let value = 7;
  for (let i = 0; i < ownerUid.length; i++) {
    value = (value * 37 + ownerUid.charCodeAt(i)) | 0;
  }
  return Math.abs(value) % 8; // 8 emblem variants
}
