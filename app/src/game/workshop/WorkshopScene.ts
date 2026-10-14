/**
 * WorkshopScene: the Pixi display graph for the workshop clearing.
 *
 * Uses geometry placeholders (labeled dev fixtures) until approved pixel art
 * is available. The layout, depth sorting, and pose logic are real; only the
 * sprite textures are placeholders.
 *
 * Owner accent allocation is STABLE: computed from the full owner roster
 * (not the visible page), so colours don't shift when owners join/leave.
 * Only cloth trim carries the accent — never the whole body.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { Application } from "pixi.js";
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
  type ClearingLayout,
} from "./layout";
import { selectFrame, type Facing, type PoseInput } from "./animation";
import { OWNER_ACCENTS, ownerAccentIndex, type OwnerAccentMap } from "./manifest";

/**
 * Normalized input for one worker's pose. In production this comes from the
 * observation contract (W01). For the dev fixture, it is explicit.
 */
export interface WorkerInput {
  id: string;
  alias: string;
  ownerUid: string | null;
  pose: PoseInput;
  facing: Facing;
}

export interface WorkshopSceneOptions {
  workers: WorkerInput[];
  ownerUid: string;
  page?: number;
  reducedMotion?: boolean;
  /** Full owner roster for stable accent allocation (not just visible page). */
  allOwnerUids?: string[];
}

export interface WorkshopSceneHandle {
  world: Container;
  tick: (delta: number) => void;
  destroy: () => void;
}

/** Placeholder colours for the dev fixture (not final art). */
const COLORS = {
  ground: 0x3a5a2c,
  groundLight: 0x4a6a3c,
  station: 0x8b6914,
  stationTop: 0xa0782c,
  workerBody: 0x4a4a6a,
  workerHead: 0xd4a574,
  ownerBody: 0x2a4a6a,
  forest: 0x2a4a2a,
  forestLight: 0x3a5a3a,
  plaqueBg: 0x1a1a2a,
  plaqueText: 0xe8e8f0,
  lamp: 0xffd700,
  lampOff: 0x555555,
  lampIdle: 0x44aa44,
  neutral: 0x666688,
} as const;

/** Max label width in scene px. Station pitch = STATION_W + AISLE = 96. */
const LABEL_MAX_W = STATION_W - 4; // 60px — fits within one station cell

const labelStyle = new TextStyle({
  fontSize: 9,
  fill: COLORS.plaqueText,
  fontFamily: "monospace",
  wordWrap: true,
  wordWrapWidth: LABEL_MAX_W,
  lineHeight: 10,
});

const statusStyle = new TextStyle({
  fontSize: 8,
  fill: 0xaaaaaa,
  fontFamily: "monospace",
  wordWrap: true,
  wordWrapWidth: LABEL_MAX_W,
});

const stripStyle = new TextStyle({
  fontSize: 9,
  fill: 0xcccccc,
  fontFamily: "monospace",
});

export function buildWorkshopScene(_app: Application, options: WorkshopSceneOptions): WorkshopSceneHandle {
  const world = new Container();
  world.label = "workshop-world";

  const reducedMotion = options.reducedMotion ?? false;
  const page = options.page ?? 0;

  // Stable owner accent map: computed from the FULL roster, not the visible page.
  // This means colours don't shift when the page changes or owners join/leave.
  const allOwners = options.allOwnerUids ?? uniqueOwners(options.workers);
  const accentMap = buildAccentMap(allOwners);

  // --- Ground ---
  const ground = new Graphics();
  ground.rect(0, 0, SCENE_W, SCENE_H).fill(COLORS.ground);
  ground.rect(CONTENT_X - 8, CONTENT_Y - 8, CONTENT_W + 16, CONTENT_H + 16).fill(COLORS.groundLight);
  world.addChild(ground);

  // --- Forest border (placeholder trees) ---
  const forest = buildForest();
  world.addChild(forest);

  // --- Layout ---
  const workerIds = options.workers.map((w) => w.id);
  const layout: ClearingLayout = layoutClearing(workerIds, page, workerIds.length);

  // --- Owner markers (one per unique owner in the visible page) ---
  const visibleOwners = uniqueOwners(options.workers);
  for (const ownerUid of visibleOwners) {
    const ownerGroup = buildOwnerMarker(ownerUid, accentMap, layout);
    world.addChild(ownerGroup);
  }

  // --- Stations + Workers ---
  const workerMap = new Map(options.workers.map((w) => [w.id, w]));
  const animated: { group: Container; worker: WorkerInput; elapsed: number; accentIdx: number }[] = [];

  for (const slot of layout.stations) {
    const worker = workerMap.get(slot.id);
    if (!worker) continue;

    const accentIdx = worker.ownerUid !== null ? (accentMap.get(worker.ownerUid) ?? 0) : -1;
    const group = buildStation(slot, worker, accentIdx, reducedMotion);
    world.addChild(group);
    animated.push({ group, worker, elapsed: 0, accentIdx });
  }

  // --- Top status strip (inside safe area: y >= SAFE_INSET_Y = 14) ---
  const strip = new Graphics();
  strip.rect(0, 14, SCENE_W, 12).fill(0x1a1a2a);
  world.addChild(strip);
  const stripText = new Text({
    text: `Workshop  ${layout.stations.length}/${layout.totalStations}  page ${page + 1}/${Math.max(1, layout.totalPages)}`,
    style: stripStyle,
  });
  stripText.position.set(8, 16);
  world.addChild(stripText);

  // --- Ticker ---
  let lastTime = 0;
  function tick(delta: number) {
    lastTime += delta;
    for (const a of animated) {
      a.elapsed += delta;
      const pose = selectFrame(
        { ...a.worker.pose, reducedMotion, elapsedMs: a.elapsed },
        a.worker.facing,
      );
      updateWorkerGraphics(a, pose.pose, reducedMotion, a.accentIdx);
    }
  }

  function destroy() {
    world.destroy({ children: true });
  }

  return { world, tick, destroy };
}

export function updateWorkshopScene(handle: WorkshopSceneHandle, _opts: WorkshopSceneOptions): void {
  // In the current implementation, the stage rebuilds the scene on prop change.
  // This export exists for future in-place updates without full rebuild.
  void handle;
  void _opts;
}

// --- helpers ---

function uniqueOwners(workers: WorkerInput[]): string[] {
  const set = new Set<string>();
  for (const w of workers) {
    if (w.ownerUid !== null) set.add(w.ownerUid);
  }
  return [...set].sort();
}

function buildAccentMap(owners: string[]): OwnerAccentMap {
  const map = new Map<string, number>();
  for (const uid of owners) {
    map.set(uid, ownerAccentIndex(uid));
  }
  return map;
}

function buildForest(): Container {
  const g = new Graphics();
  const treeW = 24;
  const treeH = 32;
  for (let x = 0; x < SCENE_W; x += treeW + 8) {
    g.rect(x, 0, treeW, treeH).fill(COLORS.forest);
    g.rect(x + 4, treeH, treeW - 8, 8).fill(0x5a3a1a);
  }
  for (let x = 0; x < SCENE_W; x += treeW + 8) {
    g.rect(x, SCENE_H - treeH, treeW, treeH).fill(COLORS.forestLight);
    g.rect(x + 4, SCENE_H - treeH - 8, treeW - 8, 8).fill(0x5a3a1a);
  }
  for (let y = treeH; y < SCENE_H - treeH; y += treeW + 8) {
    g.rect(0, y, 16, treeW).fill(COLORS.forest);
  }
  for (let y = treeH; y < SCENE_H - treeH; y += treeW + 8) {
    g.rect(SCENE_W - 16, y, 16, treeW).fill(COLORS.forestLight);
  }
  return g;
}

function buildOwnerMarker(ownerUid: string, accentMap: OwnerAccentMap, layout: ClearingLayout): Container {
  const group = new Container();
  const accentIdx = accentMap.get(ownerUid) ?? 0;
  const accent = hexToNumber(OWNER_ACCENTS[accentIdx]);

  // Position: to the left of the first row, or centred if no stations.
  let x: number, y: number;
  if (layout.stations.length > 0) {
    x = layout.stations[0].x - 40;
    y = layout.stations[0].y + 8;
  } else {
    x = SCENE_W / 2 - 16;
    y = CONTENT_Y + CONTENT_H / 2 - 24;
  }
  if (x < CONTENT_X) x = CONTENT_X;
  group.position.set(x, y);
  group.zIndex = y * 1000 + x;

  const body = new Graphics();
  // Body (neutral, NOT recoloured with accent)
  body.rect(4, 12, 24, 36).fill(COLORS.ownerBody);
  // Head
  body.circle(16, 8, 8).fill(COLORS.workerHead);
  // Accent: small cloth trim only (4px band on the chest), not whole body
  body.rect(4, 14, 24, 4).fill(accent);
  // Emblem: small square with the accent index number
  body.rect(20, 20, 8, 8).fill(0x222233);
  group.addChild(body);

  const label = new Text({
    text: ownerAlias(ownerUid),
    style: labelStyle,
  });
  label.anchor.set(0.5, 0);
  label.position.set(16, 48);
  group.addChild(label);

  return group;
}

function buildStation(
  slot: { x: number; y: number; depth: number },
  worker: WorkerInput,
  accentIdx: number,
  reducedMotion: boolean,
): Container {
  const group = new Container();
  group.position.set(slot.x, slot.y);
  group.zIndex = slot.depth;

  // Station (workbench)
  const station = new Graphics();
  station.rect(4, 20, 56, 32).fill(COLORS.station);
  station.rect(4, 18, 56, 4).fill(COLORS.stationTop);
  station.rect(20, 8, 24, 12).fill(0x1a2a3a);
  station.rect(22, 10, 20, 8).fill(0x2a4a5a);
  const isWorking = worker.pose.evidence === "busy" || worker.pose.evidence === "output";
  const isStale = worker.pose.connection === "stale" || worker.pose.connection === "disconnected";
  station.circle(52, 24, 3).fill(isStale ? COLORS.lampOff : isWorking ? COLORS.lamp : COLORS.lampIdle);
  group.addChild(station);

  // Worker
  const workerG = new Graphics();
  drawWorkerBody(workerG, worker, accentIdx, reducedMotion, 0);
  group.addChild(workerG);

  // Plaque (capped to LABEL_MAX_W)
  const alias = worker.alias.length > 16 ? worker.alias.slice(0, 16) + "…" : worker.alias;
  const plaque = new Text({ text: alias, style: labelStyle });
  plaque.anchor.set(0.5, 0);
  plaque.position.set(STATION_W / 2, STATION_H - 2);
  group.addChild(plaque);

  // Status text
  const statusText = statusLabel(worker.pose);
  if (statusText) {
    const status = new Text({ text: statusText, style: statusStyle });
    status.anchor.set(0.5, 0);
    status.position.set(STATION_W / 2, STATION_H + 10);
    group.addChild(status);
  }

  return group;
}

function drawWorkerBody(
  g: Graphics,
  worker: WorkerInput,
  accentIdx: number,
  reducedMotion: boolean,
  elapsed: number,
): void {
  g.clear();
  const pose = selectFrame(
    { ...worker.pose, reducedMotion, elapsedMs: elapsed },
    worker.facing,
  );
  // Body (neutral, NOT recoloured with accent)
  g.rect(12, 28, 16, 20).fill(COLORS.workerBody);
  // Head
  g.circle(20, 24, 6).fill(COLORS.workerHead);
  // Accent: small cloth trim only (4px band), not whole body
  if (accentIdx >= 0) {
    g.rect(12, 29, 16, 4).fill(hexToNumber(OWNER_ACCENTS[accentIdx]));
  } else {
    // Unknown ownership: neutral trim
    g.rect(12, 29, 16, 4).fill(COLORS.neutral);
  }
  // Work indicator
  if (pose.pose === "working" && !reducedMotion) {
    const armY = 32 + (pose.frame % 2) * 2;
    g.rect(28, armY, 6, 3).fill(COLORS.workerHead);
  } else if (pose.pose === "reading" && !reducedMotion) {
    g.rect(28, 30, 4, 8).fill(COLORS.workerHead);
  } else if (pose.pose === "receiving" && !reducedMotion) {
    g.rect(26, 34, 8, 4).fill(COLORS.workerHead);
  }
}

function updateWorkerGraphics(
  a: { group: Container; worker: WorkerInput; elapsed: number; accentIdx: number },
  _pose: string,
  reducedMotion: boolean,
  accentIdx: number,
): void {
  const workerG = a.group.children[1] as Graphics;
  if (workerG) {
    drawWorkerBody(workerG, a.worker, accentIdx, reducedMotion, a.elapsed);
  }
}

function ownerAlias(uid: string): string {
  // Stable short alias from the UID. Never an executable path or command.
  const short = uid.replace(/^owner-/, "");
  return short.length > 12 ? short.slice(0, 12) + "…" : short;
}

function statusLabel(pose: PoseInput): string {
  if (pose.connection === "disconnected") return "Offline";
  if (pose.connection === "stale") return "Stale";
  if (pose.receiving) return "Receiving";
  if (pose.attention) return "Needs input";
  switch (pose.evidence) {
    case "busy":
      return "Working";
    case "idle":
      return "Idle";
    case "waiting_input":
      return "Needs input";
    case "output":
      return "Output observed";
    case "unknown":
      return "Quiet · unknown";
  }
}

function hexToNumber(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}
