/**
 * Pure, bounded allocation for the local workshop demo.
 *
 * Sector origins follow a compact square spiral with a 12-tile span.
 * Existing owner sectors and agent benches survive reorder, removal and re-add.
 * Removed benches live in the serialized hiddenReservations array; their slots
 * are never reassigned. The 24-owner/32-agent budgets include retained identities.
 *
 * Bench anchors leave the owner's corner clear for a future depot. This module
 * reserves placement only; it does not implement depot geometry or behavior.
 */

const CAPACITY_PER_SECTOR = 3;
const MAX_OWNERS = 24;
const MAX_AGENTS_PER_OWNER = 32;
const SECTOR_SPAN = 12;
const MAX_SECTORS_PER_OWNER = Math.ceil(MAX_AGENTS_PER_OWNER / CAPACITY_PER_SECTOR);
const MAX_RETAINED_SECTORS = MAX_OWNERS * MAX_SECTORS_PER_OWNER;
const MAX_HIDDEN_RESERVATIONS = MAX_OWNERS * MAX_AGENTS_PER_OWNER;

/** Tile offsets; tests cover the actual projected sprite footprints. */
const BENCH_SLOTS = Object.freeze([
  Object.freeze({ slot: 0, dx: 2, dy: 8 }),
  Object.freeze({ slot: 1, dx: 6, dy: 5 }),
  Object.freeze({ slot: 2, dx: 10, dy: 2 }),
]);

/** Keep this corner free of benches, including a future owner-side depot. */
const OWNER_POS = Object.freeze({ dx: 0, dy: 0 });
/** Projected pixels relative to the sector origin; reserved, not rendered yet. */
const OWNER_DEPOT_RESERVATION = Object.freeze({ x: -52, y: 32, w: 64, h: 48 });
/** 96x80 sprite bottom-anchored here, with at least 8px of sprite clearance. */
const GATEWAY_POS = Object.freeze({ dx: 6.90625, dy: 9.84375 });
const CORRIDOR = Object.freeze({ type: 'inter-sector', border: 4 });

function spiralPositions(total) {
  const result = [{ x: 0, y: 0 }];
  let x = 0, y = 0, step = 1;
  while (result.length < total) {
    for (let dir = 0; dir < 4; dir++) {
      const dx = [1, 0, -1, 0][dir];
      const dy = [0, 1, 0, -1][dir];
      for (let n = 0; n < step; n++) {
        x += dx;
        y += dy;
        result.push({ x, y });
        if (result.length === total) return result;
      }
      if (dir % 2 === 1) step++;
    }
  }
  return result.slice(0, total);
}

const SECTOR_POSITIONS = Object.freeze(spiralPositions(MAX_RETAINED_SECTORS)
  .map(({ x, y }) => Object.freeze({ gx: x * SECTOR_SPAN, gy: y * SECTOR_SPAN })));
const SECTOR_POSITION_KEYS = new Set(SECTOR_POSITIONS.map(({ gx, gy }) => `${gx},${gy}`));
const isId = (id, maxLength = 128) => typeof id === 'string' && id.length > 0 && id.length <= maxLength;
const slotKey = (sectorId, slot) => JSON.stringify([sectorId, slot]);

/** Coordinates are derived, never trusted from a saved bench. */
function benchAt(agentId, sector, slot) {
  const offset = BENCH_SLOTS[slot];
  return {
    agentId, ownerId: sector.ownerId, sectorId: sector.id, slot,
    gx: sector.gx + offset.dx, gy: sector.gy + offset.dy,
  };
}

/** Validate bounds/bindings and normalize active plus hidden saved assignments. */
function readPrevious(previous) {
  if (!previous || !Array.isArray(previous.sectors) || !Array.isArray(previous.benches)
    || (previous.hiddenReservations !== undefined && !Array.isArray(previous.hiddenReservations))) {
    throw new Error('previous must have sectors[], benches[], and optional hiddenReservations[] arrays');
  }
  const hidden = previous.hiddenReservations ?? [];
  if (previous.sectors.length > MAX_RETAINED_SECTORS) {
    throw new Error('previous state exceeds bounded sector history');
  }
  if (previous.benches.length + hidden.length > MAX_HIDDEN_RESERVATIONS) {
    throw new Error('previous state exceeds bounded reservations');
  }

  const sectors = [];
  const sectorById = new Map();
  const positions = new Set();
  const ordinalsByOwner = new Map();
  for (const s of previous.sectors) {
    if (!s || !isId(s.id, 132) || !isId(s.ownerId)) throw new Error('previous sector has invalid identity');
    if (!Number.isFinite(s.gx) || !Number.isFinite(s.gy)) {
      throw new Error(`previous sector ${s.id}: non-finite coordinates`);
    }
    if (!Number.isInteger(s.gx) || !Number.isInteger(s.gy)) {
      throw new Error(`previous sector ${s.id}: non-integer coordinates`);
    }
    const position = `${s.gx},${s.gy}`;
    if (!SECTOR_POSITION_KEYS.has(position)) throw new Error(`previous sector ${s.id}: coordinates out of bounds`);
    if (!Number.isInteger(s.ordinal) || s.ordinal < 0 || s.ordinal >= MAX_SECTORS_PER_OWNER) {
      throw new Error(`previous sector ${s.id}: invalid ordinal`);
    }
    if (sectorById.has(s.id) || positions.has(position)) throw new Error('previous state: duplicate sector id or position');
    if (s.id !== `${s.ownerId}-${s.ordinal}`) throw new Error('previous sector identity does not match owner/ordinal');
    const ordinals = ordinalsByOwner.get(s.ownerId) ?? new Set();
    if (ordinals.has(s.ordinal)) throw new Error('previous state: duplicate sector ordinal');
    ordinals.add(s.ordinal);
    ordinalsByOwner.set(s.ownerId, ordinals);
    const sector = { id: s.id, ownerId: s.ownerId, ordinal: s.ordinal, gx: s.gx, gy: s.gy };
    sectors.push(sector);
    sectorById.set(s.id, sector);
    positions.add(position);
  }
  if (ordinalsByOwner.size > MAX_OWNERS) throw new Error(`max ${MAX_OWNERS} retained owners`);
  for (const ordinals of ordinalsByOwner.values()) {
    for (let ordinal = 0; ordinal < ordinals.size; ordinal++) {
      if (!ordinals.has(ordinal)) throw new Error('previous sector ordinals must start at zero without gaps');
    }
  }

  const assignments = new Map();
  const takenSlots = new Set();
  const countsByOwner = new Map();
  for (const b of [...previous.benches, ...hidden]) {
    if (!b || !isId(b.agentId) || !isId(b.ownerId) || !isId(b.sectorId, 132)) {
      throw new Error('previous bench has invalid identity');
    }
    if (!Number.isFinite(b.gx) || !Number.isFinite(b.gy)) {
      throw new Error(`previous bench ${b.agentId}: non-finite coordinates`);
    }
    if (!Number.isInteger(b.slot) || b.slot < 0 || b.slot >= CAPACITY_PER_SECTOR) {
      throw new Error(`previous bench ${b.agentId}: invalid slot`);
    }
    const sector = sectorById.get(b.sectorId);
    if (!sector || sector.ownerId !== b.ownerId) throw new Error('previous bench has invalid sector/owner binding');
    if (assignments.has(b.agentId)) throw new Error('previous state: duplicate bench agentId');
    const key = slotKey(b.sectorId, b.slot);
    if (takenSlots.has(key)) throw new Error('previous state: duplicate reserved slot');
    const count = (countsByOwner.get(b.ownerId) ?? 0) + 1;
    if (count > MAX_AGENTS_PER_OWNER) throw new Error(`max ${MAX_AGENTS_PER_OWNER} retained agents per owner`);
    countsByOwner.set(b.ownerId, count);
    takenSlots.add(key);
    assignments.set(b.agentId, benchAt(b.agentId, sector, b.slot));
  }
  return { sectors, assignments };
}

/**
 * @param {Array<{id: string, agentIds: string[]}>} owners
 * @param {object|null} previous - a prior result, optionally JSON round-tripped
 * @returns {{sectors: Array, benches: Array, hiddenReservations: Array, capacityPerSector: number}}
 */
export function allocateBenches(owners, previous = null) {
  if (!Array.isArray(owners)) throw new Error('owners must be an array');
  if (owners.length > MAX_OWNERS) throw new Error(`max ${MAX_OWNERS} owners`);
  const ownerIds = new Set();
  const activeAgents = new Set();
  for (const owner of owners) {
    if (!owner || !isId(owner.id)) throw new Error('owner.id must be a non-empty bounded string');
    if (ownerIds.has(owner.id)) throw new Error('duplicate owner id');
    ownerIds.add(owner.id);
    if (!Array.isArray(owner.agentIds)) throw new Error('agentIds must be an array');
    if (owner.agentIds.length > MAX_AGENTS_PER_OWNER) throw new Error(`max ${MAX_AGENTS_PER_OWNER} agents per owner`);
    for (const agentId of owner.agentIds) {
      if (!isId(agentId)) throw new Error('agentId must be a non-empty bounded string');
      if (activeAgents.has(agentId)) throw new Error('duplicate agentId');
      activeAgents.add(agentId);
    }
  }

  const held = previous === null ? { sectors: [], assignments: new Map() } : readPrevious(previous);
  const sectors = held.sectors;
  const assignments = held.assignments;
  const sectorByOwner = new Map();
  const retainedAgents = new Map();
  const occupied = new Set();
  const takenSlots = new Set();
  for (const sector of sectors) {
    const list = sectorByOwner.get(sector.ownerId) ?? [];
    list.push(sector);
    sectorByOwner.set(sector.ownerId, list);
    occupied.add(`${sector.gx},${sector.gy}`);
  }
  for (const list of sectorByOwner.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  for (const bench of assignments.values()) {
    const ids = retainedAgents.get(bench.ownerId) ?? new Set();
    ids.add(bench.agentId);
    retainedAgents.set(bench.ownerId, ids);
    takenSlots.add(slotKey(bench.sectorId, bench.slot));
  }

  const retainedOwners = new Set([...sectorByOwner.keys(), ...ownerIds]);
  if (retainedOwners.size > MAX_OWNERS) throw new Error(`max ${MAX_OWNERS} retained owners; reset explicitly to start a new world`);

  for (const owner of owners) {
    const ids = new Set(retainedAgents.get(owner.id));
    for (const agentId of owner.agentIds) {
      const heldBench = assignments.get(agentId);
      if (heldBench && heldBench.ownerId !== owner.id) throw new Error('reserved agent cannot change owner');
      ids.add(agentId);
    }
    if (ids.size > MAX_AGENTS_PER_OWNER) {
      throw new Error(`max ${MAX_AGENTS_PER_OWNER} retained agents per owner; reset explicitly to start a new world`);
    }
    const ownerSectors = sectorByOwner.get(owner.id) ?? [];
    const needed = Math.max(1, Math.ceil(ids.size / CAPACITY_PER_SECTOR));
    while (ownerSectors.length < needed) {
      const position = SECTOR_POSITIONS.find(({ gx, gy }) => !occupied.has(`${gx},${gy}`));
      if (!position || sectors.length >= MAX_RETAINED_SECTORS) throw new Error('retained sector history is full');
      const ordinal = ownerSectors.length;
      const sector = { id: `${owner.id}-${ordinal}`, ownerId: owner.id, ordinal, ...position };
      sectors.push(sector);
      ownerSectors.push(sector);
      occupied.add(`${sector.gx},${sector.gy}`);
    }
    sectorByOwner.set(owner.id, ownerSectors);

    for (const agentId of owner.agentIds) {
      if (assignments.has(agentId)) continue;
      let assigned = false;
      for (const sector of ownerSectors) {
        for (const { slot } of BENCH_SLOTS) {
          const key = slotKey(sector.id, slot);
          if (takenSlots.has(key)) continue;
          assignments.set(agentId, benchAt(agentId, sector, slot));
          takenSlots.add(key);
          assigned = true;
          break;
        }
        if (assigned) break;
      }
      if (!assigned) throw new Error('no free bench after reserving hidden assignments');
    }
  }

  const benches = owners.flatMap((owner) => owner.agentIds.map((agentId) => Object.freeze(assignments.get(agentId))));
  const hiddenReservations = [...assignments.values()]
    .filter(({ agentId }) => !activeAgents.has(agentId))
    .map((bench) => Object.freeze(bench));
  return Object.freeze({
    sectors: Object.freeze(sectors.map((sector) => Object.freeze(sector))),
    benches: Object.freeze(benches),
    hiddenReservations: Object.freeze(hiddenReservations),
    capacityPerSector: CAPACITY_PER_SECTOR,
  });
}

export {
  CAPACITY_PER_SECTOR,
  MAX_OWNERS,
  MAX_AGENTS_PER_OWNER,
  SECTOR_SPAN,
  MAX_SECTORS_PER_OWNER,
  MAX_RETAINED_SECTORS,
  MAX_HIDDEN_RESERVATIONS,
  BENCH_SLOTS,
  OWNER_POS,
  OWNER_DEPOT_RESERVATION,
  GATEWAY_POS,
  CORRIDOR,
};
