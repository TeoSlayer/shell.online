import { GARRISONS, ROADS, garrisonById, groundTiles, MAP } from "./marches";

/**
 * Where each hero holds.
 *
 * A camp is not a thing to be saved anywhere. It is a fact about a `uid`: the
 * same member gets the same ground every time, on every machine, for everybody
 * looking at the same team. Storing it would mean two places that could
 * disagree about where somebody lives, and a migration the first time the map
 * changed shape.
 *
 * The sites are solved for rather than hand-placed. Hand-placed positions were
 * the obvious thing and were wrong twice over: they have to be re-checked by
 * eye every time a holding moves or a road is added, and the checking is
 * exactly the arithmetic below. Solving it once at load costs a few
 * milliseconds and cannot drift out of step with the map.
 */

export interface Camp {
  x: number;
  y: number;
}

/** How much ground a camp takes: its barracks, its banner and its soldiers. */
export const CAMP_RADIUS = 7;

/** How many sites are solved for. Beyond this, heroes share ground. */
const SITES = 14;

/**
 * The clearances, which are what decide how many camps there are room for.
 *
 * Generous ones left room for seven sites on a map that wants fourteen, which
 * meant a team of eight had two people sharing ground. These are the smallest
 * that still keep a camp from reading as part of a holding, or from having a
 * road through the middle of it.
 */
const FROM_HOLDING = 3;
/** Clear of a road, so a camp never has a road through the middle of it. */
const FROM_ROAD = 3;
/** Clear of each other, so two camps never read as one. */
const FROM_CAMP = 4;

function roadPoints(): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (const road of ROADS) {
    const from = garrisonById(road.from);
    const to = garrisonById(road.to);
    if (!from || !to) continue;
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return points;
}

/**
 * The sites, in a stable order, best first.
 *
 * Ringed around the Keep rather than spread evenly over the country: the Keep
 * is the middle of the map and a team scattered into the far corners is a team
 * you have to go looking for one at a time. The scoring prefers ground about
 * thirty tiles out, which is past every holding's apron and well inside the
 * forest.
 */
function solveCamps(): Camp[] {
  const tiles = groundTiles();
  const roads = roadPoints();
  const middle = { x: MAP.width / 2, y: MAP.height / 2 };
  const chosen: Camp[] = [];

  const candidates: { camp: Camp; score: number }[] = [];
  for (let y = 12; y < MAP.height - 12; y += 2) {
    for (let x = 12; x < MAP.width - 12; x += 2) {
      /* Dry ground only, and dry ground all around, so nobody camps on a shore. */
      let wet = false;
      for (let dy = -3; dy <= 3 && !wet; dy += 2) {
        for (let dx = -3; dx <= 3 && !wet; dx += 2) {
          const tx = Math.round(x + dx);
          const ty = Math.round(y + dy);
          if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) continue;
          if (tiles[ty * MAP.width + tx] === "water") wet = true;
        }
      }
      if (wet) continue;

      let clear = true;
      for (const garrison of GARRISONS) {
        if (Math.hypot(x - garrison.x, y - garrison.y) < garrison.radius + CAMP_RADIUS + FROM_HOLDING) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      let nearestRoad = Infinity;
      for (const point of roads) {
        nearestRoad = Math.min(nearestRoad, Math.hypot(x - point.x, y - point.y));
      }
      if (nearestRoad < CAMP_RADIUS + FROM_ROAD) continue;

      /*
       * Wanted: about thirty tiles from the Keep, and as far from a road as
       * that allows. The road term is what stops a whole ring of camps lining
       * up along the same two highways.
       */
      const outward = Math.hypot(x - middle.x, y - middle.y);
      /*
       * Wanted: a ring about thirty tiles out, and as far from a road as that
       * allows. The distance term is weighted lightly, because weighting it
       * heavily packs every camp onto one circle and then runs out of room.
       */
      const score = -Math.abs(outward - 30) + Math.min(nearestRoad, 16);
      candidates.push({ camp: { x, y }, score });
    }
  }

  candidates.sort((first, second) => {
    if (second.score !== first.score) return second.score - first.score;
    /* A stable tie-break, so the list cannot depend on sort implementation. */
    return first.camp.y - second.camp.y || first.camp.x - second.camp.x;
  });

  for (const candidate of candidates) {
    if (chosen.length >= SITES) break;
    const tooClose = chosen.some(
      (camp) =>
        Math.hypot(camp.x - candidate.camp.x, camp.y - candidate.camp.y) <
        CAMP_RADIUS * 2 + FROM_CAMP,
    );
    if (!tooClose) chosen.push(candidate.camp);
  }

  return chosen;
}

let solved: Camp[] | undefined;

/** The camp sites, solved once. */
export function campSites(): Camp[] {
  return (solved ??= solveCamps());
}

/** A stable hash of an account id, so the same person gets the same ground. */
function hashUid(uid: string): number {
  let value = 0;
  for (let index = 0; index < uid.length; index += 1) {
    value = (Math.imul(value, 31) + uid.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

/**
 * Which camp each member holds.
 *
 * Assigned all at once rather than one at a time, because the property that
 * matters is that no two members share ground -- two camps on one spot reads as
 * a rendering fault rather than as a crowded team. A hash alone cannot promise
 * that; two ids that land on the same site would both take it.
 *
 * So: hash to a preferred site, then probe past whatever is taken. Members are
 * processed in id order so the result does not depend on the order the roster
 * happened to arrive in, and somebody joining moves at most the people they
 * collide with rather than reshuffling the whole team.
 */
export function assignCamps(uids: string[]): Map<string, Camp> {
  const sites = campSites();
  const taken = new Set<number>();
  const held = new Map<string, Camp>();
  if (sites.length === 0) return held;

  for (const uid of [...uids].sort()) {
    const wanted = hashUid(uid) % sites.length;
    let site = wanted;
    for (let probe = 0; probe < sites.length; probe += 1) {
      const at = (wanted + probe) % sites.length;
      if (taken.has(at)) continue;
      site = at;
      break;
    }
    /* More members than sites: they share, which is better than vanishing. */
    taken.add(site);
    held.set(uid, sites[site]);
  }

  return held;
}
