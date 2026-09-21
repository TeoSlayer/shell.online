/**
 * courier-flight.mjs — Pure deterministic nonlinear flight trajectory.
 *
 * Aircraft-like courier flight: smooth banked takeoff, broad curved cruise
 * (cubic Bézier with arc-length reparam), eased approach/hover/drop, return
 * on a DIFFERENT curved path, landing. Not a straight lerp+sin hump.
 *
 * No DOM, no randomness, no imports. Pure function of (from, to, elapsedMs).
 *
 * Phases: takeoff → outbound → hover → drop → return → landing → done
 * Total: ~3700ms
 */

const DURATION_MS = 3700;
const DELIVERY_MS = 2100;

const T_TAKEOFF_END = 350;
const T_OUTBOUND_END = 1550;
const T_HOVER_END = 1750;
const T_DROP_END = 2100;
const T_RETURN_END = 3400;
const T_LANDING_END = 3700;

const CRUISE_ALT = 40;
const DROP_ALT = 12;
const MAX_BANK = 0.22;
const LUT_SAMPLES = 100;

/**
 * Sample the courier flight at a given elapsed time.
 *
 * @param {object} opts
 * @param {{x: number, y: number}} opts.from - ground start point
 * @param {{x: number, y: number}} opts.to - ground destination point
 * @param {number} opts.elapsedMs - time since flight start
 * @param {boolean} [opts.reducedMotion] - simplified linear path, no bank
 * @param {number} [opts.routeSeed] - stable seed for route curvature variation
 * @returns {{x, y, altitude, heading, bank, phase, packageProgress, atDestination, done}}
 */
export function sampleCourierFlight({ from, to, elapsedMs, reducedMotion = false, routeSeed = 0 }) {
  // Validate inputs.
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) {
    throw new Error('from must have finite x, y');
  }
  if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) {
    throw new Error('to must have finite x, y');
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    // Invalid or negative time: return start state.
    return {
      x: from.x, y: from.y, altitude: 0,
      heading: 0, bank: 0,
      phase: 'takeoff', packageProgress: 0,
      atDestination: false, done: false,
    };
  }

  const dist = Math.hypot(to.x - from.x, to.y - from.y);

  // Zero distance: in-place takeoff, hover, drop, landing.
  if (dist < 0.001) {
    return zeroDistanceFlight(from, elapsedMs);
  }

  // Clamp time.
  const t = Math.min(elapsedMs, DURATION_MS);

  if (t >= DURATION_MS) {
    return {
      x: from.x, y: from.y, altitude: 0,
      heading: 0, bank: 0,
      phase: 'done', packageProgress: 1,
      atDestination: false, done: true,
    };
  }

  // Determine phase.
  let phase;
  if (t < T_TAKEOFF_END) phase = 'takeoff';
  else if (t < T_OUTBOUND_END) phase = 'outbound';
  else if (t < T_HOVER_END) phase = 'hover';
  else if (t < T_DROP_END) phase = 'drop';
  else if (t < T_RETURN_END) phase = 'return';
  else phase = 'landing';

  // Reduced motion: straight line, no bank, no curve.
  if (reducedMotion) {
    return reducedMotionFlight(from, to, t, phase, dist);
  }

  // Build routes (outbound and return are different curves).
  // Using side=+1 for both: the direction reversal (from→to vs to→from)
  // naturally places the return curve on the opposite side of the straight line.
  const outboundRoute = makeRoute(from, to, +1, routeSeed);
  const returnRoute = makeRoute(to, from, +1, routeSeed + 7);

  // Phase-specific sampling.
  let x, y, altitude, heading, bank, packageProgress, atDestination;

  switch (phase) {
    case 'takeoff': {
      const p = t / T_TAKEOFF_END;
      const eased = easeOutCubic(p);
      // Rise in place at the start point.
      x = from.x;
      y = from.y;
      altitude = CRUISE_ALT * eased;
      heading = bezierHeading(outboundRoute, 0);
      bank = 0;
      packageProgress = 0;
      atDestination = false;
      break;
    }

    case 'outbound': {
      const p = (t - T_TAKEOFF_END) / (T_OUTBOUND_END - T_TAKEOFF_END);
      const routeT = arcParam(outboundRoute, p);
      const pos = bezierPoint(outboundRoute, routeT);
      x = pos.x;
      y = pos.y;
      altitude = CRUISE_ALT;
      heading = bezierHeading(outboundRoute, routeT);
      bank = bezierBank(outboundRoute, routeT);
      packageProgress = 0;
      atDestination = false;
      break;
    }

    case 'hover': {
      const p = (t - T_OUTBOUND_END) / (T_HOVER_END - T_OUTBOUND_END);
      // Stable hover at destination with subtle bob.
      const bob = Math.sin(p * Math.PI * 2) * 0.8;
      x = to.x;
      y = to.y;
      altitude = CRUISE_ALT + bob;
      // Face the direction we arrived (outbound end tangent) for continuity.
      heading = bezierHeading(outboundRoute, 1);
      bank = 0;
      packageProgress = 0;
      atDestination = true;
      break;
    }

    case 'drop': {
      const p = (t - T_HOVER_END) / (T_DROP_END - T_HOVER_END);
      const eased = easeInOutCubic(p);
      // Descend from cruise to drop altitude.
      x = to.x;
      y = to.y;
      altitude = CRUISE_ALT - (CRUISE_ALT - DROP_ALT) * eased;
      // Smoothly rotate from arrival heading to return departure heading.
      const hArrive = bezierHeading(outboundRoute, 1);
      const hDepart = bezierHeading(returnRoute, 0);
      let dh = hDepart - hArrive;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      heading = hArrive + dh * easeInOutCubic(p);
      bank = 0;
      packageProgress = eased;
      atDestination = true;
      break;
    }

    case 'return': {
      const p = (t - T_RETURN_END + T_RETURN_END - T_DROP_END) / (T_RETURN_END - T_DROP_END);
      const routeT = arcParam(returnRoute, p);
      const pos = bezierPoint(returnRoute, routeT);
      x = pos.x;
      y = pos.y;
      // Climb from drop altitude back to cruise.
      const climbP = Math.min(1, p * 4); // climb in first 25% of return
      altitude = DROP_ALT + (CRUISE_ALT - DROP_ALT) * easeOutCubic(climbP);
      heading = bezierHeading(returnRoute, routeT);
      bank = bezierBank(returnRoute, routeT);
      packageProgress = 1;
      atDestination = false;
      break;
    }

    case 'landing': {
      const p = (t - T_RETURN_END) / (T_LANDING_END - T_RETURN_END);
      const eased = easeInCubic(p);
      // Descend in place at the origin (return already arrived at from).
      x = from.x;
      y = from.y;
      altitude = CRUISE_ALT * (1 - eased);
      heading = bezierHeading(returnRoute, 1);
      bank = 0;
      packageProgress = 1;
      atDestination = false;
      break;
    }
  }

  // Ensure endpoint accuracy.
  if (phase === 'landing' && t >= T_LANDING_END - 1) {
    x = from.x;
    y = from.y;
    altitude = 0;
  }

  return {
    x, y, altitude, heading, bank,
    phase, packageProgress,
    atDestination,
    done: false,
  };
}

/**
 * Zero-distance flight: in-place takeoff, hover, drop, landing.
 */
function zeroDistanceFlight(from, t) {
  if (t >= DURATION_MS) {
    return { x: from.x, y: from.y, altitude: 0, heading: 0, bank: 0, phase: 'done', packageProgress: 1, atDestination: false, done: true };
  }
  // Zero distance: no return flight. Landing starts immediately after drop.
  const T_ZERO_LANDING_END = T_DROP_END + 300; // 2100 + 300 = 2400
  let phase, altitude, packageProgress, atDestination;
  if (t < T_TAKEOFF_END) {
    phase = 'takeoff';
    altitude = CRUISE_ALT * easeOutCubic(t / T_TAKEOFF_END);
    packageProgress = 0;
    atDestination = true;
  } else if (t < T_HOVER_END) {
    phase = 'hover';
    altitude = CRUISE_ALT;
    packageProgress = 0;
    atDestination = true;
  } else if (t < T_DROP_END) {
    phase = 'drop';
    const p = (t - T_HOVER_END) / (T_DROP_END - T_HOVER_END);
    altitude = CRUISE_ALT - (CRUISE_ALT - DROP_ALT) * easeInOutCubic(p);
    packageProgress = easeInOutCubic(p);
    atDestination = true;
  } else if (t < T_ZERO_LANDING_END) {
    phase = 'landing';
    const p = (t - T_DROP_END) / (T_ZERO_LANDING_END - T_DROP_END);
    altitude = DROP_ALT * (1 - easeInCubic(p));
    packageProgress = 1;
    atDestination = false;
  } else {
    // Idle on ground until DURATION_MS.
    phase = 'landing';
    altitude = 0;
    packageProgress = 1;
    atDestination = false;
  }
  return { x: from.x, y: from.y, altitude, heading: 0, bank: 0, phase, packageProgress, atDestination, done: false };
}

/**
 * Reduced motion: straight line, no bank, no curve. Same phase timing.
 */
function reducedMotionFlight(from, to, t, phase, dist) {
  let x, y, altitude, heading, bank, packageProgress, atDestination;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);

  switch (phase) {
    case 'takeoff': {
      const p = easeOutCubic(t / T_TAKEOFF_END);
      x = from.x + (to.x - from.x) * p * 0.08;
      y = from.y + (to.y - from.y) * p * 0.08;
      altitude = CRUISE_ALT * p;
      heading = angle;
      bank = 0;
      packageProgress = 0;
      atDestination = false;
      break;
    }
    case 'outbound': {
      const p = (t - T_TAKEOFF_END) / (T_OUTBOUND_END - T_TAKEOFF_END);
      // Start at 8% (where takeoff ended), go to 100%.
      const progress = 0.08 + p * 0.92;
      x = from.x + (to.x - from.x) * progress;
      y = from.y + (to.y - from.y) * progress;
      altitude = CRUISE_ALT;
      heading = angle;
      bank = 0;
      packageProgress = 0;
      atDestination = false;
      break;
    }
    case 'hover': {
      x = to.x; y = to.y;
      altitude = CRUISE_ALT;
      heading = angle; // keep arrival heading (no flip)
      bank = 0;
      packageProgress = 0;
      atDestination = true;
      break;
    }
    case 'drop': {
      const p = (t - T_HOVER_END) / (T_DROP_END - T_HOVER_END);
      x = to.x; y = to.y;
      altitude = CRUISE_ALT - (CRUISE_ALT - DROP_ALT) * easeInOutCubic(p);
      // Smoothly rotate from arrival to return direction.
      heading = angle + Math.PI * easeInOutCubic(p);
      bank = 0;
      packageProgress = easeInOutCubic(p);
      atDestination = true;
      break;
    }
    case 'return': {
      const p = (t - T_DROP_END) / (T_RETURN_END - T_DROP_END);
      x = to.x + (from.x - to.x) * p;
      y = to.y + (from.y - to.y) * p;
      const climbP = Math.min(1, p * 4);
      altitude = DROP_ALT + (CRUISE_ALT - DROP_ALT) * easeOutCubic(climbP);
      heading = angle + Math.PI;
      bank = 0;
      packageProgress = 1;
      atDestination = false;
      break;
    }
    case 'landing': {
      const p = easeInCubic((t - T_RETURN_END) / (T_LANDING_END - T_RETURN_END));
      x = to.x + (from.x - to.x) * (0.92 + p * 0.08);
      y = to.y + (from.y - to.y) * (0.92 + p * 0.08);
      altitude = CRUISE_ALT * (1 - p);
      heading = angle + Math.PI;
      bank = 0;
      packageProgress = 1;
      atDestination = false;
      break;
    }
  }

  if (phase === 'landing' && t >= T_LANDING_END - 1) {
    x = from.x; y = from.y; altitude = 0;
  }

  return { x, y, altitude, heading, bank, phase, packageProgress, atDestination, done: false };
}

// --- Bézier math ---

function makeRoute(from, to, side, seed) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Perpendicular unit vector.
  const px = -dy / dist;
  const py = dx / dist;
  // Lateral offset: 25% of distance, modulated by seed for variation.
  const seedMod = 1 + ((seed % 7) - 3) * 0.05;
  const lateral = dist * 0.25 * side * seedMod;
  const p0 = { x: from.x, y: from.y };
  const p1 = { x: from.x + dx / 3 + px * lateral, y: from.y + dy / 3 + py * lateral };
  const p2 = { x: from.x + 2 * dx / 3 + px * lateral, y: from.y + 2 * dy / 3 + py * lateral };
  const p3 = { x: to.x, y: to.y };
  // Build arc-length LUT.
  const lut = buildLUT(p0, p1, p2, p3);
  return { p0, p1, p2, p3, lut };
}

function bezierPoint(route, t) {
  const { p0, p1, p2, p3 } = route;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  };
}

function bezierTangent(route, t) {
  const { p0, p1, p2, p3 } = route;
  const mt = 1 - t;
  return {
    x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
}

function bezierHeading(route, t) {
  const tan = bezierTangent(route, t);
  return Math.atan2(tan.y, tan.x);
}

function bezierBank(route, t) {
  const dt = 0.03;
  const t1 = Math.max(0, t - dt);
  const t2 = Math.min(1, t + dt);
  const h1 = bezierHeading(route, t1);
  const h2 = bezierHeading(route, t2);
  let dh = h2 - h1;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const bank = (dh / (2 * dt)) * 0.04;
  return clamp(bank, -MAX_BANK, MAX_BANK);
}

// --- Arc-length reparam LUT ---

function buildLUT(p0, p1, p2, p3) {
  const lengths = new Float64Array(LUT_SAMPLES + 1);
  let prev = { x: p0.x, y: p0.y };
  for (let i = 1; i <= LUT_SAMPLES; i++) {
    const t = i / LUT_SAMPLES;
    const mt = 1 - t;
    const pt = {
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    };
    lengths[i] = lengths[i - 1] + Math.hypot(pt.x - prev.x, pt.y - prev.y);
    prev = pt;
  }
  const total = lengths[LUT_SAMPLES] || 1;
  for (let i = 0; i <= LUT_SAMPLES; i++) lengths[i] /= total;
  return lengths;
}

function arcParam(route, targetFraction) {
  const lut = route.lut;
  const target = clamp(targetFraction, 0, 1);
  let lo = 0, hi = LUT_SAMPLES;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lut[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  const segLen = lut[lo] - lut[i];
  const frac = segLen > 0 ? (target - lut[i]) / segLen : 0;
  return (i + frac) / LUT_SAMPLES;
}

// --- Easing ---

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t) { return t * t * t; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export { DURATION_MS, DELIVERY_MS, MAX_BANK, CRUISE_ALT, DROP_ALT };
