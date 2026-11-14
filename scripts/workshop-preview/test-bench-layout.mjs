/**
 * Tests for the bench allocation module.
 * Run: node --test scripts/workshop-preview/test-bench-layout.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateBenches,
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
} from './bench-layout.mjs';

const serialized = (state) => JSON.parse(JSON.stringify(state));
const findBench = (state, agentId) => state.benches.find((bench) => bench.agentId === agentId);

describe('allocateBenches — capacity', () => {
  it('capacityPerSector is 3', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: ['a1'] }]);
    assert.equal(r.capacityPerSector, 3);
  });

  it('1 owner, 1 agent: 1 sector, 1 bench', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: ['a1'] }]);
    assert.equal(r.sectors.length, 1);
    assert.equal(r.benches.length, 1);
    assert.equal(r.benches[0].agentId, 'a1');
  });

  it('1 owner, 3 agents: 1 sector, 3 benches (full)', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }]);
    assert.equal(r.sectors.length, 1);
    assert.equal(r.benches.length, 3);
    const slots = new Set(r.benches.map((b) => b.slot));
    assert.equal(slots.size, 3);
  });

  it('1 owner, 4 agents: 2 sectors (overflow), 4 benches', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3', 'a4'] }]);
    assert.equal(r.sectors.length, 2);
    assert.equal(r.benches.length, 4);
    assert.equal(r.sectors[1].ordinal, 1);
    const a4 = r.benches.find((b) => b.agentId === 'a4');
    assert.equal(a4.sectorId, r.sectors[1].id);
    assert.equal(a4.slot, 0);
  });

  it('1 owner, 7 agents: 3 sectors, 7 benches', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: ['a1','a2','a3','a4','a5','a6','a7'] }]);
    assert.equal(r.sectors.length, 3);
    assert.equal(r.benches.length, 7);
  });

  it('1 owner, 16 agents: 6 sectors, 16 benches', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `a${i + 1}`);
    const r = allocateBenches([{ id: 'o1', agentIds: ids }]);
    assert.equal(r.sectors.length, 6);
    assert.equal(r.benches.length, 16);
  });

  it('1 owner, 32 agents: 11 sectors, 32 benches', () => {
    const ids = Array.from({ length: 32 }, (_, i) => `a${i + 1}`);
    const r = allocateBenches([{ id: 'o1', agentIds: ids }]);
    assert.equal(r.sectors.length, 11);
    assert.equal(r.benches.length, 32);
  });

  it('3 owners, 3 agents each: 3 sectors, 9 benches', () => {
    const r = allocateBenches([
      { id: 'o1', agentIds: ['a1', 'a2', 'a3'] },
      { id: 'o2', agentIds: ['b1', 'b2', 'b3'] },
      { id: 'o3', agentIds: ['c1', 'c2', 'c3'] },
    ]);
    assert.equal(r.sectors.length, 3);
    assert.equal(r.benches.length, 9);
  });
});

describe('allocateBenches — geometry (pixel collision)', () => {
  it('3 bench slots have verified screen-space separation ≥ 8px', () => {
    // Isometric: project(x,y) = {(x-y)*32, (x+y)*16}
    const project = (x, y) => ({ x: (x - y) * 32, y: (x + y) * 16 });
    // Full composite bounds: 160×140px (drone 88 + workstation 128 + interaction)
    const BOX_W = 160, BOX_H = 140;
    const MIN_GAP = 8;

    const positions = BENCH_SLOTS.map((bs) => project(bs.dx, bs.dy));
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = Math.abs(positions[i].x - positions[j].x);
        const dy = Math.abs(positions[i].y - positions[j].y);
        // No overlap if separated in x OR y (with gap).
        const separated = dx > BOX_W + MIN_GAP || dy > BOX_H + MIN_GAP;
        assert.ok(separated, `slots ${i} and ${j} overlap: dx=${dx}, dy=${dy}`);
      }
    }
  });

  it('owner position does not collide with any bench slot', () => {
    const project = (x, y) => ({ x: (x - y) * 32, y: (x + y) * 16 });
    const BOX_W = 160, BOX_H = 140, OWNER_W = 80, OWNER_H = 80;
    const MIN_GAP = 8;

    const ownerPos = project(OWNER_POS.dx, OWNER_POS.dy);
    for (const bs of BENCH_SLOTS) {
      const benchPos = project(bs.dx, bs.dy);
      const dx = Math.abs(ownerPos.x - benchPos.x);
      const dy = Math.abs(ownerPos.y - benchPos.y);
      const separated = dx > (OWNER_W + BOX_W) / 2 + MIN_GAP || dy > (OWNER_H + BOX_H) / 2 + MIN_GAP;
      assert.ok(separated, `owner and slot ${bs.slot} overlap: dx=${dx}, dy=${dy}`);
    }
  });

  it('all bench positions are within sector bounds (0-11)', () => {
    for (const bs of BENCH_SLOTS) {
      assert.ok(bs.dx >= 0 && bs.dx < SECTOR_SPAN, `slot ${bs.slot} dx=${bs.dx} out of bounds`);
      assert.ok(bs.dy >= 0 && bs.dy < SECTOR_SPAN, `slot ${bs.slot} dy=${bs.dy} out of bounds`);
    }
  });

  it('benches in built world are within sector bounds', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }]);
    for (const b of r.benches) {
      const sector = r.sectors.find((s) => s.id === b.sectorId);
      assert.ok(b.gx >= sector.gx && b.gx < sector.gx + SECTOR_SPAN);
      assert.ok(b.gy >= sector.gy && b.gy < sector.gy + SECTOR_SPAN);
    }
  });
});

describe('allocateBenches — no collisions', () => {
  it('no two benches share the same (gx, gy)', () => {
    const ids = Array.from({ length: 32 }, (_, i) => `a${i + 1}`);
    const r = allocateBenches([{ id: 'o1', agentIds: ids }]);
    const positions = new Set(r.benches.map((b) => `${b.gx},${b.gy}`));
    assert.equal(positions.size, r.benches.length);
  });

  it('no two sectors share the same (gx, gy)', () => {
    const owners = Array.from({ length: 24 }, (_, i) => ({ id: `o${i}`, agentIds: [`a${i}`] }));
    const r = allocateBenches(owners);
    const positions = new Set(r.sectors.map((s) => `${s.gx},${s.gy}`));
    assert.equal(positions.size, r.sectors.length);
  });
});

describe('allocateBenches — append stability', () => {
  it('adding an owner does not move existing sectors/benches', () => {
    const r1 = allocateBenches([
      { id: 'o1', agentIds: ['a1', 'a2'] },
      { id: 'o2', agentIds: ['b1'] },
    ]);
    const r2 = allocateBenches([
      { id: 'o1', agentIds: ['a1', 'a2'] },
      { id: 'o2', agentIds: ['b1'] },
      { id: 'o3', agentIds: ['c1'] },
    ], r1);

    for (const s of r1.sectors) {
      const match = r2.sectors.find((x) => x.id === s.id);
      assert.ok(match);
      assert.equal(match.gx, s.gx);
      assert.equal(match.gy, s.gy);
    }
    for (const b of r1.benches) {
      const match = r2.benches.find((x) => x.agentId === b.agentId);
      assert.ok(match);
      assert.equal(match.gx, b.gx);
      assert.equal(match.gy, b.gy);
      assert.equal(match.slot, b.slot);
    }
  });

  it('adding an agent does not move existing benches', () => {
    const r1 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2'] }]);
    const r2 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }], r1);
    for (const b of r1.benches) {
      const match = r2.benches.find((x) => x.agentId === b.agentId);
      assert.equal(match.gx, b.gx);
      assert.equal(match.gy, b.gy);
    }
  });
});

describe('allocateBenches — reorder stability', () => {
  it('reordering owners does not change positions', () => {
    const r1 = allocateBenches([
      { id: 'o1', agentIds: ['a1'] },
      { id: 'o2', agentIds: ['b1'] },
      { id: 'o3', agentIds: ['c1'] },
    ]);
    const r2 = allocateBenches([
      { id: 'o3', agentIds: ['c1'] },
      { id: 'o1', agentIds: ['a1'] },
      { id: 'o2', agentIds: ['b1'] },
    ], r1);
    for (const s of r1.sectors) {
      const match = r2.sectors.find((x) => x.ownerId === s.ownerId);
      assert.equal(match.gx, s.gx);
      assert.equal(match.gy, s.gy);
    }
  });

  it('reordering agents does not change bench positions', () => {
    const r1 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }]);
    const r2 = allocateBenches([{ id: 'o1', agentIds: ['a3', 'a1', 'a2'] }], r1);
    for (const b of r1.benches) {
      const match = r2.benches.find((x) => x.agentId === b.agentId);
      assert.equal(match.gx, b.gx);
      assert.equal(match.gy, b.gy);
      assert.equal(match.slot, b.slot);
    }
  });
});

describe('allocateBenches — remove/readd stability', () => {
  it('removing an owner: benches gone, sector retained', () => {
    const r1 = allocateBenches([
      { id: 'o1', agentIds: ['a1'] },
      { id: 'o2', agentIds: ['b1'] },
    ]);
    const r2 = allocateBenches([{ id: 'o1', agentIds: ['a1'] }], r1);
    assert.equal(r2.benches.find((b) => b.ownerId === 'o2'), undefined);
    const o2Sector = r2.sectors.find((s) => s.ownerId === 'o2');
    assert.ok(o2Sector);
    assert.equal(o2Sector.gx, r1.sectors.find((s) => s.ownerId === 'o2').gx);
  });

  it('removed agent readded: gets same position (hidden reservation)', () => {
    const r1 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }]);
    const a2pos = r1.benches.find((b) => b.agentId === 'a2');
    // Remove a2.
    const r2 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a3'] }], r1);
    assert.equal(r2.benches.find((b) => b.agentId === 'a2'), undefined);
    // Readd a2.
    const r3 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }], r2);
    const a2re = r3.benches.find((b) => b.agentId === 'a2');
    assert.ok(a2re, 'a2 should be present after readd');
    assert.equal(a2re.gx, a2pos.gx, 'readded bench should have same gx');
    assert.equal(a2re.gy, a2pos.gy, 'readded bench should have same gy');
    assert.equal(a2re.slot, a2pos.slot, 'readded bench should have same slot');
  });

  it('removed owner readded: gets same sector position', () => {
    const r1 = allocateBenches([
      { id: 'o1', agentIds: ['a1'] },
      { id: 'o2', agentIds: ['b1'] },
    ]);
    const o2pos = r1.sectors.find((s) => s.ownerId === 'o2');
    // Remove o2.
    const r2 = allocateBenches([{ id: 'o1', agentIds: ['a1'] }], r1);
    // Readd o2.
    const r3 = allocateBenches([
      { id: 'o1', agentIds: ['a1'] },
      { id: 'o2', agentIds: ['b1'] },
    ], r2);
    const o2re = r3.sectors.find((s) => s.ownerId === 'o2');
    assert.equal(o2re.gx, o2pos.gx);
    assert.equal(o2re.gy, o2pos.gy);
  });

  it('removed owner sector is not reused by a new owner', () => {
    const r1 = allocateBenches([
      { id: 'o1', agentIds: ['a1'] },
      { id: 'o2', agentIds: ['b1'] },
    ]);
    const r2 = allocateBenches([
      { id: 'o1', agentIds: ['a1'] },
      { id: 'o3', agentIds: ['c1'] },
    ], r1);
    const o2Pos = r1.sectors.find((s) => s.ownerId === 'o2');
    const o3Sector = r2.sectors.find((s) => s.ownerId === 'o3');
    assert.ok(o3Sector.gx !== o2Pos.gx || o3Sector.gy !== o2Pos.gy);
  });
});

describe('allocateBenches — overflow same owner', () => {
  it('4th agent goes to 2nd sector, slot 0', () => {
    const r1 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }]);
    const r2 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3', 'a4'] }], r1);
    assert.equal(r2.sectors.length, 2);
    const a4 = r2.benches.find((b) => b.agentId === 'a4');
    assert.equal(a4.sectorId, r2.sectors[1].id);
    assert.equal(a4.slot, 0);
    for (const b of r1.benches) {
      const match = r2.benches.find((x) => x.agentId === b.agentId);
      assert.equal(match.gx, b.gx);
      assert.equal(match.gy, b.gy);
    }
  });

  it('overflow sector is stable across calls', () => {
    const ids4 = ['a1', 'a2', 'a3', 'a4'];
    const r1 = allocateBenches([{ id: 'o1', agentIds: ids4 }]);
    const r2 = allocateBenches([{ id: 'o1', agentIds: ids4 }], r1);
    assert.equal(r2.sectors[1].gx, r1.sectors[1].gx);
    assert.equal(r2.sectors[1].gy, r1.sectors[1].gy);
  });

  it('reducing agents retains overflow sector (reserved)', () => {
    const r1 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3', 'a4'] }]);
    assert.equal(r1.sectors.length, 2);
    const r2 = allocateBenches([{ id: 'o1', agentIds: ['a1', 'a2', 'a3'] }], r1);
    assert.equal(r2.sectors.length, 2);
    assert.equal(r2.benches.length, 3);
    assert.equal(r2.sectors[1].gx, r1.sectors[1].gx);
  });
});

describe('allocateBenches — validation (previous state)', () => {
  it('rejects previous with Infinity coordinates', () => {
    const r1 = allocateBenches([{ id: 'o1', agentIds: ['a1'] }]);
    const bad = {
      sectors: [{ id: 'o1-0', ownerId: 'o1', ordinal: 0, gx: Infinity, gy: 0 }],
      benches: [],
      capacityPerSector: 3,
    };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: ['a1'] }], bad), /non-finite/);
  });

  it('rejects previous with NaN coordinates', () => {
    const bad = {
      sectors: [{ id: 'o1-0', ownerId: 'o1', ordinal: 0, gx: NaN, gy: 0 }],
      benches: [],
      capacityPerSector: 3,
    };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: ['a1'] }], bad), /non-finite/);
  });

  it('rejects previous with invalid slot (999)', () => {
    const bad = {
      sectors: [{ id: 'o1-0', ownerId: 'o1', ordinal: 0, gx: 0, gy: 0 }],
      benches: [{ agentId: 'a1', ownerId: 'o1', sectorId: 'o1-0', gx: 2, gy: 8, slot: 999 }],
      capacityPerSector: 3,
    };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: ['a1'] }], bad), /invalid slot/);
  });

  it('rejects previous with negative slot', () => {
    const bad = {
      sectors: [{ id: 'o1-0', ownerId: 'o1', ordinal: 0, gx: 0, gy: 0 }],
      benches: [{ agentId: 'a1', ownerId: 'o1', sectorId: 'o1-0', gx: 2, gy: 8, slot: -1 }],
      capacityPerSector: 3,
    };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: ['a1'] }], bad), /invalid slot/);
  });

  it('rejects previous with duplicate bench agentId', () => {
    const bad = {
      sectors: [{ id: 'o1-0', ownerId: 'o1', ordinal: 0, gx: 0, gy: 0 }],
      benches: [
        { agentId: 'a1', ownerId: 'o1', sectorId: 'o1-0', gx: 2, gy: 8, slot: 0 },
        { agentId: 'a1', ownerId: 'o1', sectorId: 'o1-0', gx: 6, gy: 5, slot: 1 },
      ],
      capacityPerSector: 3,
    };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: ['a1'] }], bad), /duplicate bench/);
  });

  it('rejects previous with duplicate sector position', () => {
    const bad = {
      sectors: [
        { id: 'o1-0', ownerId: 'o1', ordinal: 0, gx: 0, gy: 0 },
        { id: 'o2-0', ownerId: 'o2', ordinal: 0, gx: 0, gy: 0 },
      ],
      benches: [],
      capacityPerSector: 3,
    };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: [] }], bad), /duplicate sector/);
  });

  it('rejects previous with non-integer coordinates', () => {
    const bad = {
      sectors: [{ id: 'o1-0', ownerId: 'o1', ordinal: 0, gx: 0.5, gy: 0 }],
      benches: [],
      capacityPerSector: 3,
    };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: [] }], bad), /non-integer/);
  });

  it('rejects previous with excessive history (> MAX_RETAINED_SECTORS)', () => {
    const manySectors = Array.from({ length: MAX_RETAINED_SECTORS + 1 }, (_, i) => ({
      id: `o${i % 24}-${Math.floor(i / 24)}-x`,
      ownerId: `o${i % 24}`,
      ordinal: Math.floor(i / 24),
      gx: (i % 24) * 12,
      gy: Math.floor(i / 24) * 12,
    }));
    const bad = { sectors: manySectors, benches: [], capacityPerSector: 3 };
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: [] }], bad), /exceeds bounded/);
  });
});

describe('allocateBenches — input validation', () => {
  it('throws on duplicate owner id', () => {
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: [] }, { id: 'o1', agentIds: [] }]), /duplicate owner/);
  });

  it('throws on duplicate agent id', () => {
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: ['a1', 'a1'] }]), /duplicate agentId/);
  });

  it('throws on too many owners', () => {
    const owners = Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, agentIds: [] }));
    assert.throws(() => allocateBenches(owners), /max 24/);
  });

  it('throws on too many agents', () => {
    const ids = Array.from({ length: 33 }, (_, i) => `a${i}`);
    assert.throws(() => allocateBenches([{ id: 'o1', agentIds: ids }]), /max 32/);
  });

  it('throws on empty owner id', () => {
    assert.throws(() => allocateBenches([{ id: '', agentIds: [] }]), /non-empty/);
  });
});

describe('allocateBenches — safe bounds', () => {
  it('24 owners all fit within spiral', () => {
    const owners = Array.from({ length: 24 }, (_, i) => ({ id: `o${i}`, agentIds: [`a${i}`] }));
    const r = allocateBenches(owners);
    assert.equal(r.sectors.length, 24);
    for (const s of r.sectors) {
      assert.ok(Number.isFinite(s.gx));
      assert.ok(Number.isFinite(s.gy));
    }
  });

  it('24 owners × 32 agents: all fit, no collisions', () => {
    const owners = Array.from({ length: 24 }, (_, i) => ({
      id: `o${i}`,
      agentIds: Array.from({ length: 32 }, (_, j) => `a${i}-${j}`),
    }));
    const r = allocateBenches(owners);
    assert.equal(r.benches.length, 24 * 32);
    const positions = new Set(r.benches.map((b) => `${b.gx},${b.gy}`));
    assert.equal(positions.size, r.benches.length);
  });
});

describe('allocateBenches — freeze/clone', () => {
  it('result is deeply frozen', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: ['a1'] }]);
    assert.throws(() => { r.capacityPerSector = 99; }, /read only|frozen/i);
    assert.throws(() => { r.sectors[0].gx = 999; }, /read only|frozen/i);
    assert.throws(() => { r.benches[0].gx = 999; }, /read only|frozen/i);
  });

  it('caller mutation of input does not affect result', () => {
    const owners = [{ id: 'o1', agentIds: ['a1', 'a2'] }];
    const r = allocateBenches(owners);
    owners[0].agentIds.push('a3');
    assert.equal(r.benches.length, 2);
  });
});

describe('allocateBenches — deterministic', () => {
  it('same input → same output', () => {
    const owners = [
      { id: 'o1', agentIds: ['a1', 'a2', 'a3'] },
      { id: 'o2', agentIds: ['b1'] },
    ];
    const r1 = allocateBenches(owners);
    const r2 = allocateBenches(owners);
    assert.deepEqual(r1, r2);
  });

  it('sequential allocation is deterministic', () => {
    let r = allocateBenches([{ id: 'o1', agentIds: ['a1'] }]);
    for (let i = 2; i <= 5; i++) {
      r = allocateBenches([{ id: 'o1', agentIds: ['a1'] }, { id: `o${i}`, agentIds: [`b${i}`] }], r);
    }
    let r2 = allocateBenches([{ id: 'o1', agentIds: ['a1'] }]);
    for (let i = 2; i <= 5; i++) {
      r2 = allocateBenches([{ id: 'o1', agentIds: ['a1'] }, { id: `o${i}`, agentIds: [`b${i}`] }], r2);
    }
    assert.deepEqual(r, r2);
  });
});

describe('allocateBenches — 0 agents', () => {
  it('owner with 0 agents gets 1 sector (home), 0 benches', () => {
    const r = allocateBenches([{ id: 'o1', agentIds: [] }]);
    assert.equal(r.sectors.length, 1);
    assert.equal(r.benches.length, 0);
  });
});

describe('serialized reservations', () => {
  it('keeps a removed bench reserved through replacement, multiple polls and re-add', () => {
    const initial = allocateBenches([{ id: 'owner', agentIds: ['a', 'b', 'c'] }]);
    const originalB = findBench(initial, 'b');
    let state = allocateBenches([{ id: 'owner', agentIds: ['a', 'c'] }], serialized(initial));
    assert.deepEqual(state.hiddenReservations, [originalB]);
    assert.equal(findBench(state, 'b'), undefined);
    for (let i = 0; i < 3; i++) {
      state = allocateBenches([{ id: 'owner', agentIds: ['c', 'a'] }], serialized(state));
      assert.deepEqual(state.hiddenReservations, [originalB]);
    }
    state = allocateBenches([{ id: 'owner', agentIds: ['d', 'a', 'c'] }], serialized(state));
    const originalD = findBench(state, 'd');
    assert.notEqual(originalD.sectorId, originalB.sectorId, 'the hidden slot must force overflow');
    assert.deepEqual(state.hiddenReservations, [originalB]);
    state = allocateBenches([{ id: 'owner', agentIds: ['b', 'd', 'c', 'a'] }], serialized(state));
    assert.deepEqual(findBench(state, 'b'), originalB);
    assert.deepEqual(findBench(state, 'd'), originalD);
    assert.equal(state.hiddenReservations.length, 0);
  });

  it('preserves every bench when an absent owner returns with reversed agent order', () => {
    const initial = allocateBenches([{ id: 'owner', agentIds: ['a', 'b', 'c', 'd'] }]);
    let state = allocateBenches([], serialized(initial));
    state = allocateBenches([], serialized(state));
    state = allocateBenches([{ id: 'other', agentIds: ['new'] }], serialized(state));
    assert.equal(state.hiddenReservations.length, 4);
    state = allocateBenches([
      { id: 'other', agentIds: ['new'] },
      { id: 'owner', agentIds: ['d', 'c', 'b', 'a'] },
    ], serialized(state));
    for (const bench of initial.benches) assert.deepEqual(findBench(state, bench.agentId), bench);
  });

  it('reads older results without a hiddenReservations property', () => {
    const initial = serialized(allocateBenches([{ id: 'owner', agentIds: ['a'] }]));
    delete initial.hiddenReservations;
    const next = allocateBenches([{ id: 'owner', agentIds: ['a', 'b'] }], initial);
    assert.deepEqual(findBench(next, 'a'), initial.benches[0]);
  });

  it('freezes hidden reservations and never mutates a serialized input', () => {
    const initial = serialized(allocateBenches([{ id: 'owner', agentIds: ['a', 'b'] }]));
    const before = serialized(initial);
    const next = allocateBenches([{ id: 'owner', agentIds: ['a'] }], initial);
    assert.deepEqual(initial, before);
    assert.ok(Object.isFrozen(next.hiddenReservations));
    assert.ok(Object.isFrozen(next.hiddenReservations[0]));
    assert.throws(() => { next.hiddenReservations[0].gx = 900; }, /read only|frozen/i);
  });

  it('counts hidden identities toward the 32-agent budget without displacing them', () => {
    const ids = Array.from({ length: MAX_AGENTS_PER_OWNER }, (_, i) => `a${i}`);
    const initial = allocateBenches([{ id: 'owner', agentIds: ids }]);
    const hidden = allocateBenches([{ id: 'owner', agentIds: [] }], serialized(initial));
    assert.equal(hidden.hiddenReservations.length, MAX_AGENTS_PER_OWNER);
    assert.throws(() => allocateBenches([{ id: 'owner', agentIds: ['new'] }], serialized(hidden)), /max 32 retained/);
    const restored = allocateBenches([{ id: 'owner', agentIds: [...ids].reverse() }], serialized(hidden));
    for (const bench of initial.benches) assert.deepEqual(findBench(restored, bench.agentId), bench);
  });

  it('bounds retained owners while permitting all original owners to return', () => {
    const owners = Array.from({ length: MAX_OWNERS }, (_, i) => ({ id: `o${i}`, agentIds: [`a${i}`] }));
    const initial = allocateBenches(owners);
    const hidden = allocateBenches([], serialized(initial));
    assert.throws(() => allocateBenches([{ id: 'new-owner', agentIds: [] }], serialized(hidden)), /max 24 retained owners/);
    const restored = allocateBenches([...owners].reverse(), serialized(hidden));
    for (const bench of initial.benches) assert.deepEqual(findBench(restored, bench.agentId), bench);
  });

  it('round-trips a maximum world with all 768 benches hidden then restored', () => {
    const owners = Array.from({ length: MAX_OWNERS }, (_, i) => ({
      id: `o${i}`, agentIds: Array.from({ length: MAX_AGENTS_PER_OWNER }, (_, j) => `a${i}-${j}`),
    }));
    const initial = allocateBenches(owners);
    const hidden = allocateBenches([], serialized(initial));
    assert.equal(hidden.hiddenReservations.length, MAX_HIDDEN_RESERVATIONS);
    assert.equal(hidden.sectors.length, MAX_RETAINED_SECTORS);
    const restored = allocateBenches(owners, serialized(hidden));
    assert.deepEqual(restored.benches, initial.benches);
    assert.equal(restored.hiddenReservations.length, 0);
  });
});

describe('saved assignment validation', () => {
  it('recomputes forged finite coordinates for active and hidden benches', () => {
    const initial = allocateBenches([{ id: 'owner', agentIds: ['a', 'b'] }]);
    const saved = serialized(allocateBenches([{ id: 'owner', agentIds: ['a'] }], initial));
    saved.benches[0].gx = 1e90;
    saved.benches[0].gy = -123.5;
    saved.hiddenReservations[0].gx = -1e90;
    saved.hiddenReservations[0].gy = 0.125;
    const hidden = allocateBenches([{ id: 'owner', agentIds: ['a'] }], saved);
    assert.deepEqual(hidden.benches[0], findBench(initial, 'a'));
    assert.deepEqual(hidden.hiddenReservations[0], findBench(initial, 'b'));
    const restored = allocateBenches([{ id: 'owner', agentIds: ['b', 'a'] }], serialized(hidden));
    assert.deepEqual(findBench(restored, 'b'), findBench(initial, 'b'));
  });

  it('rejects hidden reservations sharing an active slot', () => {
    const saved = serialized(allocateBenches([{ id: 'owner', agentIds: ['a'] }]));
    saved.hiddenReservations = [{ ...saved.benches[0], agentId: 'b' }];
    assert.throws(() => allocateBenches([], saved), /duplicate reserved slot/);
  });

  it('rejects a repeated identity across active and hidden assignments', () => {
    const saved = serialized(allocateBenches([{ id: 'owner', agentIds: ['a'] }]));
    saved.hiddenReservations = [{ ...saved.benches[0], slot: 1 }];
    assert.throws(() => allocateBenches([], saved), /duplicate bench/);
  });

  it('rejects missing/cross-owner sector references, including hidden ones', () => {
    const initial = serialized(allocateBenches([
      { id: 'one', agentIds: ['a'] }, { id: 'two', agentIds: ['b'] },
    ]));
    for (const sectorId of ['missing', 'two-0']) {
      const saved = serialized(initial);
      const bench = saved.benches.shift();
      saved.hiddenReservations = [{ ...bench, sectorId }];
      assert.throws(() => allocateBenches([], saved), /sector\/owner binding/);
    }
  });

  it('rejects malformed or excessive hidden arrays before allocating', () => {
    const initial = serialized(allocateBenches([{ id: 'owner', agentIds: ['a'] }]));
    assert.throws(() => allocateBenches([], { ...initial, hiddenReservations: {} }), /arrays/);
    assert.throws(() => allocateBenches([], {
      ...initial, hiddenReservations: Array(MAX_HIDDEN_RESERVATIONS).fill(initial.benches[0]),
    }), /exceeds bounded reservations/);
    const saved = serialized(initial);
    saved.hiddenReservations = [{ ...saved.benches.pop(), gx: Infinity }];
    assert.throws(() => allocateBenches([], saved), /non-finite/);
  });

  it('rejects sector origins outside the bounded allocation lattice', () => {
    const initial = serialized(allocateBenches([{ id: 'owner', agentIds: ['a'] }]));
    for (const gx of [1, 100000]) {
      const saved = serialized(initial);
      saved.sectors[0].gx = gx;
      assert.throws(() => allocateBenches([], saved), /coordinates out of bounds/);
    }
  });

  it('rejects duplicate agent identities across owners and ownership changes', () => {
    assert.throws(() => allocateBenches([
      { id: 'one', agentIds: ['shared'] }, { id: 'two', agentIds: ['shared'] },
    ]), /duplicate agentId/);
    const saved = allocateBenches([{ id: 'one', agentIds: ['shared'] }]);
    assert.throws(() => allocateBenches([{ id: 'two', agentIds: ['shared'] }], saved), /cannot change owner/);
  });

  it('can re-read allocations at the maximum accepted identity length', () => {
    const owners = [{ id: 'o'.repeat(128), agentIds: ['a'.repeat(128)] }];
    const initial = allocateBenches(owners);
    assert.deepEqual(allocateBenches(owners, serialized(initial)), initial);
  });
});

describe('actual render footprints across sectors', () => {
  const project = (x, y) => ({ x: (x - y) * 32, y: (x + y) * 16 });
  const gap = (a, b) => Math.max(
    Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w),
    Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h),
  );
  const renderBounds = (bench) => {
    const p = project(bench.gx, bench.gy);
    // Current draw offsets, including Math.round() at sprite placement.
    return [
      { type: 'desk', x: p.x - 25, y: p.y - 88, w: 88, h: 88 },
      { type: 'idle drone', x: p.x - 69, y: p.y - 37, w: 88, h: 88 },
      { type: 'working drone', x: Math.round(p.x + 32.2) - 44, y: Math.round(p.y - 63.25) - 44, w: 88, h: 88 },
      { type: 'integrated 96', x: p.x - 48, y: p.y - 82, w: 96, h: 96 },
      { type: 'selection', x: p.x - 54, y: p.y - 78, w: 122, h: 118 },
    ];
  };
  const world = () => allocateBenches(Array.from({ length: MAX_OWNERS }, (_, i) => ({
    id: `o${i}`, agentIds: [`a${i}`, `b${i}`, `c${i}`],
  })));

  it('clears every owner from station sprites in its own and neighboring sectors', () => {
    assert.deepEqual(OWNER_POS, { dx: 0, dy: 0 });
    const state = world();
    for (const sector of state.sectors) {
      const p = project(sector.gx + OWNER_POS.dx, sector.gy + OWNER_POS.dy);
      const owner = { x: p.x - 40, y: p.y - 71, w: 80, h: 80 };
      for (const bench of state.benches) {
        for (const bounds of renderBounds(bench)) {
          assert.ok(gap(owner, bounds) >= 8, `${sector.ownerId} overlaps ${bench.agentId} ${bounds.type}`);
        }
      }
    }
  });

  it('does not overlap actual station sprites across adjacent sector boundaries', () => {
    const state = world();
    for (let i = 0; i < state.benches.length; i++) {
      for (let j = i + 1; j < state.benches.length; j++) {
        for (const a of renderBounds(state.benches[i])) {
          for (const b of renderBounds(state.benches[j])) {
            assert.ok(gap(a, b) >= 0, `${state.benches[i].agentId} ${a.type} overlaps ${state.benches[j].agentId} ${b.type}`);
          }
        }
      }
    }
  });

  it('reserves an empty owner-side depot footprint without allocating or rendering it', () => {
    const state = world();
    for (const sector of state.sectors) {
      const origin = project(sector.gx, sector.gy);
      const depot = { ...OWNER_DEPOT_RESERVATION, x: origin.x + OWNER_DEPOT_RESERVATION.x, y: origin.y + OWNER_DEPOT_RESERVATION.y };
      const owner = { x: origin.x - 40, y: origin.y - 71, w: 80, h: 80 };
      assert.ok(gap(depot, owner) >= 8);
      for (const bench of state.benches) {
        for (const bounds of renderBounds(bench)) {
          assert.ok(gap(depot, bounds) >= 8, `${sector.ownerId} depot overlaps ${bench.agentId} ${bounds.type}`);
        }
      }
    }
  });

  it('keeps the 96x80 gateway and package pad clear of all 24 owners and station sprites', () => {
    const state = world();
    const p = project(GATEWAY_POS.dx, GATEWAY_POS.dy);
    assert.deepEqual(p, { x: -94, y: 268 });
    const gateway = { x: p.x - 48, y: p.y - 80, w: 96, h: 80 };
    // Source/package pad is centered 35px above the gateway anchor in demo.js.
    const packagePad = { x: p.x - 10, y: p.y - 43, w: 20, h: 16 };
    for (const sector of state.sectors) {
      const origin = project(sector.gx, sector.gy);
      const owner = { x: origin.x - 40, y: origin.y - 71, w: 80, h: 80 };
      const depot = { ...OWNER_DEPOT_RESERVATION, x: origin.x + OWNER_DEPOT_RESERVATION.x, y: origin.y + OWNER_DEPOT_RESERVATION.y };
      for (const rect of [gateway, packagePad]) {
        assert.ok(gap(rect, owner) >= 8, `gateway crowds ${sector.ownerId}`);
        assert.ok(gap(rect, depot) >= 8, `gateway crowds ${sector.ownerId} depot reservation`);
      }
    }
    for (const bench of state.benches) {
      // Selection brackets are UI overlays, not the station's rendered contents.
      for (const bounds of renderBounds(bench).filter(({ type }) => type !== 'selection')) {
        for (const rect of [gateway, packagePad]) {
          assert.ok(gap(rect, bounds) >= 8, `gateway crowds ${bench.agentId} ${bounds.type}`);
        }
      }
    }
  });
});
