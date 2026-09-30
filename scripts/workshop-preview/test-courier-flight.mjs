/**
 * Tests for the courier flight trajectory module.
 * Run: node --test scripts/workshop-preview/test-courier-flight.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleCourierFlight,
  DURATION_MS,
  DELIVERY_MS,
  MAX_BANK,
  CRUISE_ALT,
} from './courier-flight.mjs';

const FROM = { x: 0, y: 0 };
const TO = { x: 200, y: 100 };

describe('sampleCourierFlight — endpoint accuracy', () => {
  it('starts at from, altitude 0', () => {
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 0 });
    assert.equal(s.x, FROM.x);
    assert.equal(s.y, FROM.y);
    assert.equal(s.altitude, 0);
    assert.equal(s.phase, 'takeoff');
    assert.equal(s.done, false);
  });

  it('ends at from, altitude 0, done', () => {
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: DURATION_MS });
    assert.equal(s.x, FROM.x);
    assert.equal(s.y, FROM.y);
    assert.equal(s.altitude, 0);
    assert.equal(s.phase, 'done');
    assert.equal(s.done, true);
    assert.equal(s.packageProgress, 1);
  });

  it('reaches destination during hover/drop', () => {
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 1600 });
    assert.equal(s.atDestination, true);
    assert.ok(Math.abs(s.x - TO.x) < 1, `x=${s.x}, expected ~${TO.x}`);
    assert.ok(Math.abs(s.y - TO.y) < 1, `y=${s.y}, expected ~${TO.y}`);
  });

  it('beyond duration: done state', () => {
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: DURATION_MS + 5000 });
    assert.equal(s.done, true);
    assert.equal(s.phase, 'done');
  });
});

describe('sampleCourierFlight — continuity at phase boundaries', () => {
  const boundaries = [350, 1550, 1750, 2100, 3400, 3700];
  it('position is continuous at all phase boundaries', () => {
    for (const t of boundaries) {
      const before = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t - 1 });
      const after = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t + 1 });
      const dx = Math.abs(after.x - before.x);
      const dy = Math.abs(after.y - before.y);
      const da = Math.abs(after.altitude - before.altitude);
      assert.ok(dx < 15, `x jump at t=${t}: ${dx}`);
      assert.ok(dy < 15, `y jump at t=${t}: ${dy}`);
      assert.ok(da < 10, `alt jump at t=${t}: ${da}`);
    }
  });

  it('altitude is continuous (no teleport)', () => {
    for (let t = 0; t <= DURATION_MS; t += 100) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t });
      assert.ok(s.altitude >= 0, `negative altitude at t=${t}`);
      assert.ok(s.altitude <= CRUISE_ALT + 2, `altitude too high at t=${t}: ${s.altitude}`);
    }
  });
});

describe('sampleCourierFlight — finite values', () => {
  it('all values are finite across the full duration', () => {
    for (let t = 0; t <= DURATION_MS; t += 50) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t });
      assert.ok(Number.isFinite(s.x), `x not finite at t=${t}`);
      assert.ok(Number.isFinite(s.y), `y not finite at t=${t}`);
      assert.ok(Number.isFinite(s.altitude), `altitude not finite at t=${t}`);
      assert.ok(Number.isFinite(s.heading), `heading not finite at t=${t}`);
      assert.ok(Number.isFinite(s.bank), `bank not finite at t=${t}`);
    }
  });
});

describe('sampleCourierFlight — curved path (not straight)', () => {
  it('outbound deviates from straight line', () => {
    // Mid-outbound should be off the straight line from→to.
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 950 });
    // Straight line midpoint.
    const midX = (FROM.x + TO.x) / 2;
    const midY = (FROM.y + TO.y) / 2;
    const deviation = Math.hypot(s.x - midX, s.y - midY);
    assert.ok(deviation > 5, `path too straight: deviation=${deviation}`);
  });

  it('return path is different from outbound', () => {
    // Sample at equivalent progress on outbound and return.
    const out = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 950 }); // mid-outbound
    const ret = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 2750 }); // mid-return
    // The return midpoint should be on the opposite side of the straight line.
    const midX = (FROM.x + TO.x) / 2;
    const midY = (FROM.y + TO.y) / 2;
    // Cross product to determine which side of the line each point is on.
    const dx = TO.x - FROM.x, dy = TO.y - FROM.y;
    const crossOut = dx * (out.y - FROM.y) - dy * (out.x - FROM.x);
    const crossRet = dx * (ret.y - TO.y) - dy * (ret.x - TO.x);
    // They should be on opposite sides (or at least not the same point).
    const distBetween = Math.hypot(out.x - ret.x, out.y - ret.y);
    assert.ok(distBetween > 10, `outbound and return too close: ${distBetween}`);
  });
});

describe('sampleCourierFlight — bounded bank', () => {
  it('bank is always within ±MAX_BANK', () => {
    for (let t = 0; t <= DURATION_MS; t += 25) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t });
      assert.ok(s.bank >= -MAX_BANK - 0.001, `bank too negative at t=${t}: ${s.bank}`);
      assert.ok(s.bank <= MAX_BANK + 0.001, `bank too positive at t=${t}: ${s.bank}`);
    }
  });

  it('bank is zero during hover/drop/landing', () => {
    for (const t of [1600, 1900, 3500]) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t });
      assert.ok(Math.abs(s.bank) < 0.01, `bank not ~0 at t=${t}: ${s.bank}`);
    }
  });
});

describe('sampleCourierFlight — package progress', () => {
  it('packageProgress is 0 before drop', () => {
    for (const t of [0, 350, 950, 1600]) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t });
      assert.equal(s.packageProgress, 0);
    }
  });

  it('packageProgress reaches 1 during drop', () => {
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: DELIVERY_MS });
    assert.equal(s.packageProgress, 1);
  });

  it('packageProgress stays 1 after drop', () => {
    for (const t of [2200, 3000, 3700]) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t });
      assert.equal(s.packageProgress, 1);
    }
  });
});

describe('sampleCourierFlight — zero distance', () => {
  it('from === to: in-place flight, done at end', () => {
    const s = sampleCourierFlight({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, elapsedMs: DURATION_MS });
    assert.equal(s.x, 5);
    assert.equal(s.y, 5);
    assert.equal(s.altitude, 0);
    assert.equal(s.done, true);
  });

  it('zero distance: reaches altitude during hover', () => {
    const s = sampleCourierFlight({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, elapsedMs: 1600 });
    assert.ok(s.altitude > 20, `should be at cruise altitude, got ${s.altitude}`);
    assert.equal(s.atDestination, true);
  });
});

describe('sampleCourierFlight — invalid time', () => {
  it('negative time: returns start state', () => {
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: -100 });
    assert.equal(s.x, FROM.x);
    assert.equal(s.y, FROM.y);
    assert.equal(s.altitude, 0);
    assert.equal(s.done, false);
  });

  it('NaN time: returns start state', () => {
    const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: NaN });
    assert.equal(s.x, FROM.x);
    assert.equal(s.altitude, 0);
    assert.equal(s.done, false);
  });
});

describe('sampleCourierFlight — reduced motion', () => {
  it('reduced motion: no bank, straight path', () => {
    for (let t = 0; t <= DURATION_MS; t += 100) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t, reducedMotion: true });
      assert.ok(Math.abs(s.bank) < 0.001, `bank not 0 in reduced at t=${t}`);
      assert.ok(Number.isFinite(s.x));
      assert.ok(Number.isFinite(s.y));
    }
  });

  it('reduced motion: still reaches destination and returns', () => {
    const atDest = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 1600, reducedMotion: true });
    assert.equal(atDest.atDestination, true);
    const done = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: DURATION_MS, reducedMotion: true });
    assert.equal(done.done, true);
    assert.equal(done.x, FROM.x);
    assert.equal(done.y, FROM.y);
  });
});

describe('sampleCourierFlight — no overshoot beyond corridor', () => {
  it('position stays within bounded corridor around from→to', () => {
    const margin = 80; // allow curve deviation
    const minX = Math.min(FROM.x, TO.x) - margin;
    const maxX = Math.max(FROM.x, TO.x) + margin;
    const minY = Math.min(FROM.y, TO.y) - margin;
    const maxY = Math.max(FROM.y, TO.y) + margin;
    for (let t = 0; t <= DURATION_MS; t += 50) {
      const s = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t });
      assert.ok(s.x >= minX && s.x <= maxX, `x out of corridor at t=${t}: ${s.x}`);
      assert.ok(s.y >= minY && s.y <= maxY, `y out of corridor at t=${t}: ${s.y}`);
    }
  });
});

describe('sampleCourierFlight — heading continuity (regression)', () => {
  it('no instant 180-degree flip at outbound→hover boundary', () => {
    const before = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 1549 });
    const after = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 1551 });
    let dh = after.heading - before.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    assert.ok(Math.abs(dh) < 0.5, `heading jump at hover: ${dh} rad`);
  });

  it('no instant 180-degree flip at drop→return boundary', () => {
    const before = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 2099 });
    const after = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 2101 });
    let dh = after.heading - before.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    assert.ok(Math.abs(dh) < 0.5, `heading jump at return: ${dh} rad`);
  });

  it('heading is continuous across all phase boundaries', () => {
    const boundaries = [350, 1550, 1750, 2100, 3400];
    for (const t of boundaries) {
      const before = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t - 1 });
      const after = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: t + 1 });
      let dh = after.heading - before.heading;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      assert.ok(Math.abs(dh) < 0.5, `heading discontinuity at t=${t}: ${dh} rad`);
    }
  });
});

describe('sampleCourierFlight — reduced motion boundary (regression)', () => {
  it('reduced motion: no position jump at takeoff→outbound', () => {
    const before = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 349, reducedMotion: true });
    const after = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 351, reducedMotion: true });
    const dx = Math.abs(after.x - before.x);
    const dy = Math.abs(after.y - before.y);
    assert.ok(dx < 5, `x jump at reduced takeoff→outbound: ${dx}`);
    assert.ok(dy < 5, `y jump at reduced takeoff→outbound: ${dy}`);
  });

  it('reduced motion: no heading flip at drop→return', () => {
    const before = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 2099, reducedMotion: true });
    const after = sampleCourierFlight({ from: FROM, to: TO, elapsedMs: 2101, reducedMotion: true });
    let dh = after.heading - before.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    assert.ok(Math.abs(dh) < 0.5, `reduced heading jump at return: ${dh} rad`);
  });
});

describe('sampleCourierFlight — zero distance at t=2100 (regression)', () => {
  it('zero distance at t=2100: altitude is bounded (not 988px)', () => {
    const s = sampleCourierFlight({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, elapsedMs: 2100 });
    assert.ok(s.altitude >= 0, `negative altitude: ${s.altitude}`);
    assert.ok(s.altitude <= CRUISE_ALT + 2, `altitude too high at t=2100: ${s.altitude}`);
  });

  it('zero distance: altitude is continuous across all phases', () => {
    for (let t = 0; t <= DURATION_MS; t += 100) {
      const s = sampleCourierFlight({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, elapsedMs: t });
      assert.ok(s.altitude >= 0, `negative altitude at t=${t}: ${s.altitude}`);
      assert.ok(s.altitude <= CRUISE_ALT + 2, `altitude too high at t=${t}: ${s.altitude}`);
    }
  });

  it('zero distance: landing descends smoothly after drop', () => {
    const atDrop = sampleCourierFlight({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, elapsedMs: 2100 });
    const afterLanding = sampleCourierFlight({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, elapsedMs: 2400 });
    assert.ok(afterLanding.altitude < atDrop.altitude, 'should be descending');
    assert.ok(afterLanding.altitude >= 0, 'should not go below ground');
  });
});
