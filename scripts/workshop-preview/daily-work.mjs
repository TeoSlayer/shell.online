// Daily work reducer + crate packing — pure, preview-only logistics.
//
// Models the visual pipeline: command package (accepted) -> bench work
// (started) -> output -> confirmed completed crate (completed) -> courier
// (depot_received) -> daily owner depot pile. The completed count is a VERIFIED
// FACT that drives neat crate stacking and cosmetic milestones; the courier /
// transport visual (depot_received) is logistics, not a count. `delivered` is
// the host ACK of MCP input delivery: it is a harmless no-op and never
// terminalizes a job or credits anything.
//
// Pure and dependency-free: no Date.now, no localStorage, no server, no
// provider. `now` and the timezone are explicit (Intl timezone), so tests are
// repeatable. This is demo-normalized input, NOT production auth or storage.
//
// Crates are OUTPUT UNITS — not token progress, not human productivity.
// Milestones are cosmetic perks; an unlock never grants permissions, rate or
// model autonomy.

const MAX_RECORDS = 512;      // bounded per-identity lifecycle records
const MAX_SEEN = 512;         // bounded completion-dedup keys (fail closed)
const RETAIN_DAYS = 7;        // max calendar-day history retained
const MAX_ID_LEN = 64;
const HARD_MAX_VISIBLE = 36;  // crate geometry hard cap

const EVENT_TYPES = new Set([
  'accepted', 'started', 'output', 'completed', 'failed', 'cancelled', 'delivered', 'depot_received',
]);
// Monotone lifecycle rank for the work stages. `delivered` is not a stage: it is
// the host ACK of MCP input delivery and is a harmless no-op. `depot_received`
// is output logistics after completion and never credits.
const RANK = { accepted: 1, started: 2, output: 3, completed: 4 };

// Cosmetic milestone thresholds (example). Count 0 -> level 0.
const MILESTONES = Object.freeze([
  Object.freeze({ at: 3, perk: 'depot trim' }),
  Object.freeze({ at: 8, perk: 'courier paint' }),
  Object.freeze({ at: 20, perk: 'workshop banner' }),
]);

/* --- pure helpers ------------------------------------------------------- */

function isBoundedId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID_LEN;
}

// Calendar day key (YYYY-MM-DD) for a timestamp in an explicit timezone, via
// Intl. en-CA yields the ISO date shape. Never uses the ambient timezone.
// Throws on an invalid timezone; callers catch and treat it as an invalid
// input rather than letting the reducer throw.
function dayKeyFor(atMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return dtf.format(new Date(atMs));
}

// Retention cutoff: the first day still retained when `now` is the current day.
// Calendar arithmetic on the formatted date components (UTC maths on Y/M/D),
// never "subtract 144h", so a DST transition cannot shift the horizon by a day.
function cutoffKeyFor(nowKey, days) {
  const [year, month, day] = nowKey.split('-').map(Number);
  const cutoff = new Date(Date.UTC(year, month - 1, day - (days - 1)));
  const y = cutoff.getUTCFullYear();
  const m = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
  const d = String(cutoff.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Collision-free lifecycle identity: the full tuple source + owner + run + job
// as a JSON array. A separator scheme (owner|run|job) collides as soon as an id
// contains the separator, so no unescaped delimiter is used anywhere.
function identityKey(source, ownerId, runId, jobId) {
  return JSON.stringify([source, ownerId, runId, jobId]);
}

function makeState(records, seen, daily) {
  return Object.freeze({
    version: 2,
    records: Object.freeze(records.map((r) => Object.freeze({ ...r }))),
    seen: Object.freeze(seen.map((s) => Object.freeze({ ...s }))),
    daily: Object.freeze(daily.map((d) => Object.freeze({ ...d }))),
  });
}

function isValidEvent(event, mode) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.source !== mode) return false; // source must match the mode
  if (!isBoundedId(event.id)) return false;
  if (!isBoundedId(event.jobId)) return false;
  if (!isBoundedId(event.droneId)) return false;
  if (!isBoundedId(event.ownerId)) return false;
  if (!isBoundedId(event.runId)) return false;
  if (!Number.isFinite(event.at) || event.at < 0) return false;
  if (!EVENT_TYPES.has(event.type)) return false;
  return true;
}

// Monotone lifecycle guard for one identity. `record` is the identity's current
// state (or null for a new identity). Out-of-order by time, mismatched owner or
// drone (drone binding), terminal->completed, backwards steps and any
// `delivered` (host ACK) are rejected; the caller returns the state unchanged.
function transitionAllowed(record, event) {
  // An unseen identity is only ever created by work events: an ACK or a
  // logistics event with no completed record behind it must not materialize one.
  if (!record) return event.type !== 'delivered' && event.type !== 'depot_received';
  if (record.ownerId !== event.ownerId) return false; // mismatched ownership
  if (record.droneId !== event.droneId) return false; // drone binding is fixed per identity
  if (event.at < record.lastAt) return false;         // out of order by time
  const current = record.status;
  if (current === 'failed' || current === 'cancelled') return false; // terminal
  if (event.type === 'delivered') return false;       // host ACK: harmless no-op
  if (current === 'completed') return event.type === 'depot_received';
  if (current === 'depot_received') return false;     // logistics is terminal
  if (event.type === 'depot_received') return false;  // only accepted after completed
  if (event.type === 'failed' || event.type === 'cancelled') return true;
  if (event.type === 'output') return RANK[current] <= 3;
  return RANK[event.type] >= RANK[current];           // monotone forward
}

function incrementDaily(daily, ownerId, dayKey) {
  const idx = daily.findIndex((d) => d.ownerId === ownerId && d.dayKey === dayKey);
  if (idx === -1) return [...daily, { ownerId, dayKey, count: 1 }];
  return daily.map((d, i) => (i === idx ? { ...d, count: d.count + 1 } : d));
}

function pruneDaily(daily, cutoffKey) {
  return daily.filter((d) => d.dayKey >= cutoffKey);
}

/* --- state + reducer ---------------------------------------------------- */

export function createDailyWorkState() {
  return makeState([], [], []);
}

/**
 * Fold one normalized work event into the state, returning a NEW immutable
 * state (or the same state when the event is rejected/harmless).
 *
 * opts: { timeZone = 'Europe/Bucharest', mode = 'local-sandbox', now }
 *   `now` is REQUIRED and must be finite: it drives the future-event guard and
 *   the 7-calendar-day window. Date.now is never called here.
 *
 * Rules:
 * - only `completed` credits a crate, once per identity
 *   (source + owner + run + job);
 * - `delivered` (host ACK of MCP input delivery) is a harmless no-op;
 * - `depot_received` (output logistics) is accepted only after `completed`
 *   and never credits;
 * - events in the future or older than the retained window are refused, as are
 *   invalid timestamps/timezones (unchanged state, never a throw);
 * - failed/cancelled are terminal and, like completed, are retained for the
 *   whole horizon; at capacity new identities are refused (fail closed) and
 *   nothing is evicted to make room for them. Existing identities still settle.
 */
export function recordWorkEvent(
  state,
  event,
  { timeZone = 'Europe/Bucharest', mode = 'local-sandbox', now } = {},
) {
  if (!isValidEvent(event, mode)) return state;
  if (!Number.isFinite(now) || now < 0) return state; // explicit finite now required
  if (event.at > now) return state;                    // future events refused

  let nowKey;
  let eventKey;
  try {
    nowKey = dayKeyFor(now, timeZone);                 // invalid timezone -> unchanged
    eventKey = dayKeyFor(event.at, timeZone);
  } catch {
    return state;
  }
  const cutoffKey = cutoffKeyFor(nowKey, RETAIN_DAYS);
  if (eventKey < cutoffKey) return state;              // outside the retained window

  // Prune before capacity accounting, so expired records cannot crowd out
  // current identities and an old replay cannot be re-credited.
  let records = state.records.filter((r) => r.dayKey >= cutoffKey);
  let seen = state.seen.filter((s) => s.dayKey >= cutoffKey);
  let daily = pruneDaily(state.daily, cutoffKey);

  const key = identityKey(event.source, event.ownerId, event.runId, event.jobId);
  const record = records.find((r) => r.key === key);
  if (!transitionAllowed(record, event)) return state;

  if (record) {
    records = records.map((r) => (r.key === key
      // dayKey tracks the latest lifecycle day (settlement included), so a
      // recently cancelled/completed identity is retained for the full horizon
      // instead of being pruned by its acceptance day.
      ? { ...r, status: event.type, droneId: event.droneId, lastAt: Math.max(r.lastAt, event.at), dayKey: eventKey }
      : r));
  } else {
    if (records.length >= MAX_RECORDS) return state;   // fail closed: never evict to admit
    records = [...records, {
      key,
      source: event.source,
      jobId: event.jobId,
      ownerId: event.ownerId,
      runId: event.runId,
      droneId: event.droneId,
      status: event.type,
      lastAt: event.at,
      dayKey: eventKey,
    }];
  }

  if (event.type === 'completed') {
    if (!seen.some((s) => s.key === key)) {
      if (seen.length < MAX_SEEN) {
        seen = [...seen, { key, dayKey: eventKey }];
        daily = incrementDaily(daily, event.ownerId, eventKey);
      }
      // else: seen is full -> fail closed, no credit (never evict-and-recount)
    }
  }

  return makeState(records, seen, daily);
}

/* --- reports ------------------------------------------------------------ */

/**
 * Per-owner, per-day report -> { pending, active, completed, milestone }.
 * pending = accepted (not yet worked); active = started/output (being worked);
 * completed = verified crates that COMPLETED on this day; milestone from that
 * daily count. Unresolved work is not per-day: a job accepted or started on an
 * earlier day still counts as pending/active on later report days until it
 * actually settles, while a completion credits only its own completion day.
 * dayKey is an explicit argument, so days never silently merge.
 */
export function dailyOwnerWork(state, ownerId, dayKey) {
  const daily = state.daily.find((d) => d.ownerId === ownerId && d.dayKey === dayKey);
  const completed = daily ? daily.count : 0;
  const unresolved = state.records.filter((r) => r.ownerId === ownerId && r.dayKey <= dayKey);
  const active = unresolved.filter((r) => r.status === 'started' || r.status === 'output').length;
  const pending = unresolved.filter((r) => r.status === 'accepted').length;
  return Object.freeze({
    pending, active, completed,
    milestone: milestoneFor(completed),
  });
}

/**
 * Shared team level for a day: the SUMMED verified daily count across owners.
 * Cosmetic only; no cross-day unlock storage is kept yet.
 */
export function sharedTeamWork(state, dayKey) {
  const total = state.daily
    .filter((d) => d.dayKey === dayKey)
    .reduce((sum, d) => sum + d.count, 0);
  const m = milestoneFor(total);
  return Object.freeze({
    dayKey, totalCompleted: total, level: m.level, nextAt: m.nextAt, perk: m.perk,
  });
}

/* --- crate packing ------------------------------------------------------ */

/**
 * Neat, deterministic stacking for a verified crate count.
 * 3 cols x 2 rows x 3 layers = 18 crates per pallet; subsequent pallets are
 * offset. Visible geometry is HARD-capped at 36 crates: a caller asking for
 * 1e9, Infinity or a non-finite cap can never grow the loop or the allocation.
 * The position of crate i is a pure function of i, so the prefix is stable as
 * the count grows (no random tumbling). Crates are output units.
 */
export function packDailyCrates(count, { maxVisible = HARD_MAX_VISIBLE } = {}) {
  const COLS = 3, ROWS = 2, LAYERS = 3;
  const CRATES_PER_PALLET = COLS * ROWS * LAYERS; // 18
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  const requested = Number.isFinite(maxVisible) ? Math.floor(maxVisible) : HARD_MAX_VISIBLE;
  const cap = Math.max(0, Math.min(HARD_MAX_VISIBLE, requested));
  const visible = Math.min(n, cap);
  const crates = [];
  for (let i = 0; i < visible; i += 1) {
    const pallet = Math.floor(i / CRATES_PER_PALLET);
    const inPallet = i % CRATES_PER_PALLET;
    const layer = Math.floor(inPallet / (COLS * ROWS));
    const inLayer = inPallet % (COLS * ROWS);
    const row = Math.floor(inLayer / COLS);
    const col = inLayer % COLS;
    const x = pallet * (COLS + 1) + col; // pallet offset + column
    const y = layer;                      // height
    const z = row;                        // depth
    crates.push(Object.freeze({ index: i, pallet, row, col, layer, x, y, z }));
  }
  return Object.freeze({ crates, overflowCount: Math.max(0, n - cap) });
}

/* --- milestones --------------------------------------------------------- */

/**
 * Cosmetic milestone for a verified count. Count 0 -> level 0. `perk` is the
 * highest reached perk; `nextAt` is the count for the next level (null when
 * all are reached). Unlocks never grant permissions/rate/model autonomy.
 */
export function milestoneFor(count) {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  let level = 0;
  for (const m of MILESTONES) if (n >= m.at) level += 1;
  const current = MILESTONES[level - 1];
  const next = MILESTONES[level];
  return Object.freeze({
    level,
    nextAt: next ? next.at : null,
    perk: current ? current.perk : null,
  });
}
