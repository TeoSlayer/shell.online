#!/usr/bin/env node
// Tests for the daily work reducer + crate packing. Pure, no external network.
//
// Run: node scripts/workshop-preview/test-daily-work.mjs
// Exit 0 = all pass; exit 1 = at least one failure.
import {
  createDailyWorkState,
  recordWorkEvent,
  dailyOwnerWork,
  sharedTeamWork,
  packDailyCrates,
  milestoneFor,
} from './daily-work.mjs';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TZ = 'Europe/Bucharest';
const MODE = 'local-sandbox';
const D1 = Date.parse('2026-09-21T12:00:00Z'); // -> 2026-09-21 in Bucharest
const D2 = Date.parse('2026-09-22T12:00:00Z'); // -> 2026-09-22
const D1_KEY = '2026-09-21';
const D2_KEY = '2026-09-22';
const ev = (over = {}) => ({
  id: 'ev-1', jobId: 'job-1', droneId: 'drone-1', ownerId: 'owner-1', runId: 'run-1',
  type: 'completed', source: MODE, at: D1, ...over,
});
// `now` is explicit and defaults to the event's own time in the helper.
const rec = (state, event, opts = {}) => recordWorkEvent(state, event, { timeZone: TZ, mode: MODE, now: opts.now ?? event.at, ...opts });

console.log('daily work test\n');

console.log('[state] createDailyWorkState is empty + frozen');
{
  const s = createDailyWorkState();
  check('empty state (0 records/seen/daily)', s.records.length === 0 && s.seen.length === 0 && s.daily.length === 0);
  check('state and arrays are frozen', Object.isFrozen(s) && Object.isFrozen(s.records) && Object.isFrozen(s.daily));
}

console.log('\n[credit] only completed counts; ACK/output/delivered never credit');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'accepted' }));
  s = rec(s, ev({ type: 'started', at: D1 + 1000 }));
  s = rec(s, ev({ type: 'output', at: D1 + 2000 }));
  check('accepted/started/output do NOT credit', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 0);
  s = rec(s, ev({ type: 'completed', at: D1 + 3000 }));
  check('completed credits exactly 1', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 1);
  s = rec(s, ev({ type: 'delivered', at: D1 + 4000 }));
  check('delivered does NOT add a second credit', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 1);
}

console.log('\n[ack] host delivery ACK is a no-op; depot_received is logistics, not credit');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'accepted' }));
  s = rec(s, ev({ type: 'started', at: D1 + 1000 }));
  const beforeAck = s;
  s = rec(s, ev({ type: 'delivered', at: D1 + 1500 }));
  check('delivered mid-work is a harmless no-op (same state)', s === beforeAck);
  s = rec(s, ev({ type: 'output', at: D1 + 2000 }));
  s = rec(s, ev({ type: 'completed', at: D1 + 3000 }));
  check('work completes after a host ACK no-op', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 1);
  const afterCompleted = s;
  s = rec(s, ev({ type: 'depot_received', at: D1 + 4000 }));
  check('depot_received after completed is accepted (status moves)', s !== afterCompleted && s.records[0].status === 'depot_received');
  check('depot_received never adds a crate', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 1);
  let t = createDailyWorkState();
  t = rec(t, ev({ type: 'accepted' }));
  const beforeDepot = t;
  t = rec(t, ev({ type: 'depot_received', at: D1 + 1000 }));
  check('depot_received before completed is rejected', t === beforeDepot);
  let u = createDailyWorkState();
  u = rec(u, ev({ type: 'accepted' }));
  u = rec(u, ev({ type: 'failed', at: D1 + 1000 }));
  const afterFail = u;
  u = rec(u, ev({ type: 'depot_received', at: D1 + 2000 }));
  check('depot_received after failed is rejected', u === afterFail);
  // unseen identity edge cases: an ACK must not create one, logistics needs completed
  const blank = createDailyWorkState();
  check('delivered for an unseen identity is a same-state no-op', rec(blank, ev({ type: 'delivered' })) === blank && blank.records.length === 0);
  check('depot_received for an unseen identity is rejected', rec(blank, ev({ type: 'depot_received' })) === blank && blank.records.length === 0);
}

console.log('\n[duplicate] same identity completed counts once; re-render harmless');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'completed' }));
  const first = s;
  s = rec(s, ev({ type: 'completed' })); // exact re-render
  check('duplicate completed does not double-credit', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 1);
  check('re-render returns the same state (harmless)', s === first);
}

console.log('\n[terminal] failed/cancelled cannot later turn completed without a new identity');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'accepted' }));
  s = rec(s, ev({ type: 'failed', at: D1 + 1000 }));
  const afterFail = s;
  s = rec(s, ev({ type: 'completed', at: D1 + 2000 }));
  check('completed after failed is rejected (no credit, same state)', s === afterFail && dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 0);
  // a new run for the same job is a new identity and can complete
  s = rec(s, ev({ type: 'accepted', runId: 'run-2', at: D1 + 3000 }));
  s = rec(s, ev({ type: 'completed', runId: 'run-2', at: D1 + 4000 }));
  check('new run (run-2) can complete and credit', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 1);
}

console.log('\n[identity] full tuple keys are collision-free; drone binding held');
{
  let s = createDailyWorkState();
  // pipe-containing ids that would collide under an unescaped owner|run|job scheme
  s = rec(s, ev({ type: 'completed', ownerId: 'a|b', runId: 'r', jobId: 'c', id: 'k1' }));
  s = rec(s, ev({ type: 'completed', ownerId: 'a', runId: 'b|r', jobId: 'c', id: 'k2' }));
  check('pipe-containing tuples do not collide (2 credits)', s.daily.reduce((sum, d) => sum + d.count, 0) === 2);
  // same jobId under different runs are different identities
  let t = createDailyWorkState();
  t = rec(t, ev({ type: 'accepted' }));
  t = rec(t, ev({ type: 'accepted', runId: 'run-2', at: D1 + 1000 }));
  check('same jobId, different runId -> two identities', t.records.length === 2);
  t = rec(t, ev({ type: 'completed', runId: 'run-2', at: D1 + 2000 }));
  check('run-2 completes its own identity', dailyOwnerWork(t, 'owner-1', D1_KEY).completed === 1);
  check('run-1 identity is unaffected (still pending)', dailyOwnerWork(t, 'owner-1', D1_KEY).pending === 1);
  // drone binding
  let u = createDailyWorkState();
  u = rec(u, ev({ type: 'accepted' }));
  const bound = u;
  u = rec(u, ev({ type: 'started', droneId: 'drone-2', at: D1 + 1000 }));
  check('a different drone cannot continue the identity', u === bound);
}

console.log('\n[guards] ownership, out-of-order, source mismatch, invalid');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'accepted' }));
  const base = s;
  const otherOwner = rec(s, ev({ type: 'started', ownerId: 'owner-2', at: D1 + 1000 }));
  check('a different owner is a different identity; the original is untouched',
    otherOwner !== base && otherOwner.records.length === 2
    && dailyOwnerWork(otherOwner, 'owner-1', D1_KEY).pending === 1
    && dailyOwnerWork(otherOwner, 'owner-2', D1_KEY).active === 1);
  check('out-of-order (at < lastAt) rejected', rec(s, ev({ type: 'started', at: D1 - 5000 })) === base);
  check('source != mode rejected', rec(s, ev({ type: 'started', source: 'simulated', at: D1 + 1000 })) === base);
  check('non-finite at rejected', rec(s, ev({ type: 'started', at: NaN, id: 'ev-nf' })) === base);
  check('over-long id rejected', rec(s, ev({ type: 'started', id: 'x'.repeat(65), at: D1 + 1000 })) === base);
}

console.log('\n[time] explicit now, future and window guards, invalid input, calendar horizon');
{
  const empty = createDailyWorkState();
  check('missing now returns unchanged state', recordWorkEvent(empty, ev({ type: 'accepted' }), { timeZone: TZ, mode: MODE }) === empty);
  check('non-finite now returns unchanged state', recordWorkEvent(empty, ev({ type: 'accepted' }), { timeZone: TZ, mode: MODE, now: NaN }) === empty);
  const s0 = rec(createDailyWorkState(), ev({ type: 'completed' }));
  check('future event rejected', rec(s0, ev({ type: 'accepted', jobId: 'jf', at: D1 + 60000 }), { now: D1 }) === s0);
  let threw = false;
  let invalid;
  try { invalid = recordWorkEvent(s0, ev({ type: 'accepted', jobId: 'jt', id: 'e-jt' }), { timeZone: 'Not/AZone', mode: MODE, now: D1 }); }
  catch { threw = true; }
  check('invalid timezone returns unchanged state without throwing', !threw && invalid === s0);
  const D7 = Date.parse('2026-09-28T12:00:00Z');
  const fresh7 = createDailyWorkState();
  const outside = rec(fresh7, ev({ type: 'completed', id: 'edge-no', jobId: 'edge-no', at: Date.parse('2026-09-21T12:00:00Z') }), { now: D7 });
  check('event outside the retained window is rejected', outside === fresh7);
  const edgeOk = rec(createDailyWorkState(), ev({ type: 'completed', id: 'edge-ok', jobId: 'edge-ok', at: Date.parse('2026-09-22T00:30:00Z') }), { now: D7 });
  check('event on the cutoff day is accepted', edgeOk.daily.length === 1);
  // old replay cannot recredit
  let s = rec(createDailyWorkState(), ev({ type: 'completed' })); // D1
  s = rec(s, ev({ type: 'accepted', id: 'el', jobId: 'job-l', ownerId: 'owner-l', at: D7 }), { now: D7 });
  const replayed = rec(s, ev({ type: 'completed' }), { now: D7 });
  check('old replay is rejected and cannot recredit', replayed === s && dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 0);
  // calendar horizon across the autumn DST change (Oct 25 2026, Bucharest)
  const NOW_OCT = Date.parse('2026-10-26T10:00:00Z');
  const beforeDST = rec(createDailyWorkState(), ev({ type: 'completed', id: 'dst-no', jobId: 'dst-no', at: Date.parse('2026-10-19T08:00:00Z') }), { now: NOW_OCT });
  const withinDST = rec(createDailyWorkState(), ev({ type: 'completed', id: 'dst-ok', jobId: 'dst-ok', at: Date.parse('2026-10-20T08:00:00Z') }), { now: NOW_OCT });
  check('calendar horizon spans the DST change (Oct 20 accepted, Oct 19 rejected)', beforeDST.daily.length === 0 && withinDST.daily.length === 1);
}

console.log('\n[days] unresolved work spans days; completion credits its own day');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'accepted' }));               // D1
  s = rec(s, ev({ type: 'started', at: D1 + 1000 })); // D1
  check('started yesterday is still active today', dailyOwnerWork(s, 'owner-1', D2_KEY).active === 1);
  check('yesterday report also shows it active (unresolved)', dailyOwnerWork(s, 'owner-1', D1_KEY).active === 1);
  s = rec(s, ev({ type: 'completed', at: D2 }));      // completes D2
  check('completion credits the completion day, not the accepted day', dailyOwnerWork(s, 'owner-1', D2_KEY).completed === 1 && dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 0);
  check('settled work no longer counts as active', dailyOwnerWork(s, 'owner-1', D2_KEY).active === 0);
  let t = createDailyWorkState();
  t = rec(t, ev({ type: 'accepted', jobId: 'job-p', id: 'e-p' }));
  check('accepted yesterday remains pending today', dailyOwnerWork(t, 'owner-1', D2_KEY).pending === 1);
  // the record tracks the latest lifecycle day, not the accepted day
  const DAY = 86400000;
  let c = createDailyWorkState();
  c = rec(c, ev({ type: 'accepted' }));               // day 1
  const D7 = D1 + 6 * DAY;                            // day 7
  const D8 = D1 + 7 * DAY;                            // day 8
  c = rec(c, ev({ type: 'cancelled', at: D7 }), { now: D7 });
  check('cancelled record dayKey is the settlement day', c.records[0].dayKey === '2026-09-27');
  const replay = rec(c, ev({ type: 'completed', at: D8 }), { now: D8 });
  check('cancellation still blocks a replayed completion after day rollover', replay === c && c.daily.length === 0);
  // same proof for a completed identity: its completion day keeps it retained
  let d = createDailyWorkState();
  d = rec(d, ev({ type: 'accepted' }));
  d = rec(d, ev({ type: 'completed', at: D7 }), { now: D7 });
  check('completed record dayKey is the completion day', d.records[0].dayKey === '2026-09-27');
  const duplicateLate = rec(d, ev({ type: 'completed', at: D8 }), { now: D8 });
  check('a late duplicate cannot recredit after rollover', duplicateLate === d && d.daily.reduce((sum, x) => sum + x.count, 0) === 1);
}

console.log('\n[day] boundary + Intl timezone (midnight/DST), no silent cross-day reset');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'completed' })); // D1
  check('D1 credited, D2 untouched', dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 1 && dailyOwnerWork(s, 'owner-1', D2_KEY).completed === 0);
  // a UTC Sep-20 23:00 event is Sep-21 02:00 in Bucharest -> D1, not D0
  let s2 = createDailyWorkState();
  s2 = rec(s2, ev({ type: 'completed', at: Date.parse('2026-09-20T23:00:00Z') }));
  check('late UTC event maps to next local day (Bucharest)', dailyOwnerWork(s2, 'owner-1', D1_KEY).completed === 1 && dailyOwnerWork(s2, 'owner-1', '2026-09-20').completed === 0);
}

console.log('\n[retention] 7-day max, explicit now, never Date.now');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'completed' })); // D1
  check('D1 present before pruning', s.daily.some((d) => d.dayKey === D1_KEY));
  // an event 8 days later prunes D1 (cutoff = now-6 calendar days)
  const later = D1 + 8 * 86400000;
  s = rec(s, ev({ type: 'accepted', jobId: 'job-later', at: later }), { now: later });
  check('D1 pruned after 7 days (explicit now)', !s.daily.some((d) => d.dayKey === D1_KEY));
  // purity: same input -> deep-equal output; rejected -> same reference
  const a = rec(createDailyWorkState(), ev({ type: 'completed' }));
  const b = rec(createDailyWorkState(), ev({ type: 'completed' }));
  check('pure reducer (identical output for identical input)', JSON.stringify(a) === JSON.stringify(b));
}

console.log('\n[bounded] capacity fails closed: no eviction, protected records retained');
{
  // one failed identity, then fill the capacity with others
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'accepted', id: 'ea1', jobId: 'job-1', ownerId: 'owner-1', at: D1 }));
  s = rec(s, ev({ type: 'failed', id: 'ef1', jobId: 'job-1', ownerId: 'owner-1', at: D1 + 1 }));
  for (let i = 0; i < 511; i += 1) {
    s = rec(s, ev({ type: 'accepted', id: `e${i}`, jobId: `tj-${i}`, ownerId: `to-${i}`, at: D1 + 2 + i }));
  }
  check('records bounded to 512', s.records.length === 512);
  const refused = rec(s, ev({ type: 'accepted', id: 'e-late', jobId: 'job-late', ownerId: 'owner-late', at: D1 + 600 }));
  check('at capacity a new identity is refused (no eviction)', refused === s && s.records.length === 512);
  const late = rec(s, ev({ type: 'completed', id: 'ec1', jobId: 'job-1', ownerId: 'owner-1', at: D1 + 601 }));
  check('protected failed record retained; late completed rejected', late === s && dailyOwnerWork(s, 'owner-1', D1_KEY).completed === 0);
  const settled = rec(s, ev({ type: 'completed', id: 'ec0', jobId: 'tj-0', ownerId: 'to-0', at: D1 + 602 }));
  check('existing accepted work still settles while full and credits', settled.records.length === 512 && dailyOwnerWork(settled, 'to-0', D1_KEY).completed === 1);
  // pruning happens before capacity accounting
  const D9 = D1 + 7 * 86400000;
  const fresh = rec(s, ev({ type: 'accepted', id: 'e-fresh', jobId: 'job-fresh', ownerId: 'owner-fresh', at: D9 }), { now: D9 });
  check('prune before capacity: a new identity is admitted after the horizon passes', fresh.records.length === 1);
  // seen cap still fails closed for distinct completions
  let s2 = createDailyWorkState();
  for (let i = 0; i < 520; i += 1) {
    s2 = rec(s2, ev({ type: 'completed', id: `c${i}`, jobId: `job-${i}`, ownerId: `owner-${i}`, at: D1 + i }));
  }
  const total = s2.daily.reduce((sum, d) => sum + d.count, 0);
  check('seen cap 512 -> 8 completions fail closed (512 credited)', total === 512 && s2.seen.length === 512);
}

console.log('\n[packing] bounds, no collision, stable prefix, hard cap');
{
  const p40 = packDailyCrates(40);
  check('count 40 -> 36 visible + overflowCount 4', p40.crates.length === 36 && p40.overflowCount === 4);
  check('crate 0 is pallet 0 origin', JSON.stringify(p40.crates[0]) === JSON.stringify({ index: 0, pallet: 0, row: 0, col: 0, layer: 0, x: 0, y: 0, z: 0 }));
  const cellKeys = new Set(p40.crates.map((c) => `${c.pallet}:${c.row}:${c.col}:${c.layer}`));
  const xyzKeys = new Set(p40.crates.map((c) => `${c.x},${c.y},${c.z}`));
  check('no cell collision (pallet,row,col,layer unique)', cellKeys.size === p40.crates.length);
  check('no xyz collision', xyzKeys.size === p40.crates.length);
  check('18 crates per pallet (3x2x3)', p40.crates.filter((c) => c.pallet === 0).length === 18);
  const p20 = packDailyCrates(20);
  const p21 = packDailyCrates(21);
  check('stable prefix (first 20 identical for count 20 vs 21)',
    JSON.stringify(p20.crates) === JSON.stringify(p21.crates.slice(0, 20)));
  check('count 0 -> no crates, no overflow', packDailyCrates(0).crates.length === 0 && packDailyCrates(0).overflowCount === 0);
  const huge = packDailyCrates(1e9);
  check('hard cap at 36 even for 1e9', huge.crates.length === 36 && huge.overflowCount === 1e9 - 36);
  check('non-finite maxVisible falls back to the hard cap', packDailyCrates(40, { maxVisible: Infinity }).crates.length === 36 && packDailyCrates(40, { maxVisible: 1e9 }).crates.length === 36);
  check('finite smaller cap respected', packDailyCrates(40, { maxVisible: 5 }).crates.length === 5 && packDailyCrates(40, { maxVisible: 5 }).overflowCount === 35);
}

console.log('\n[milestone] cosmetic levels, count 0 -> level 0');
{
  check('count 0 -> level 0, nextAt 3, no perk', JSON.stringify(milestoneFor(0)) === JSON.stringify({ level: 0, nextAt: 3, perk: null }));
  check('count 3 -> level 1 "depot trim"', milestoneFor(3).level === 1 && milestoneFor(3).perk === 'depot trim' && milestoneFor(3).nextAt === 8);
  check('count 8 -> level 2 "courier paint"', milestoneFor(8).level === 2 && milestoneFor(8).perk === 'courier paint' && milestoneFor(8).nextAt === 20);
  check('count 20 -> level 3 "workshop banner", nextAt null', milestoneFor(20).level === 3 && milestoneFor(20).perk === 'workshop banner' && milestoneFor(20).nextAt === null);
  check('count 100 stays level 3 (no runaway)', milestoneFor(100).level === 3);
}

console.log('\n[report] pending vs active vs completed; shared team sum');
{
  let s = createDailyWorkState();
  s = rec(s, ev({ type: 'accepted', jobId: 'job-p', id: 'e-p' }));            // pending
  s = rec(s, ev({ type: 'started', jobId: 'job-a', id: 'e-a', at: D1 + 1000 })); // active
  s = rec(s, ev({ type: 'completed', jobId: 'job-c', id: 'e-c', at: D1 + 2000 })); // completed
  const rep = dailyOwnerWork(s, 'owner-1', D1_KEY);
  check('report pending=1 active=1 completed=1', rep.pending === 1 && rep.active === 1 && rep.completed === 1);
  check('report milestone reflects completed', rep.milestone.level === 0);
  // shared team = summed verified daily count across owners
  let t = createDailyWorkState();
  t = rec(t, ev({ type: 'completed', ownerId: 'owner-1', jobId: 'j1', id: 'e1' }));
  t = rec(t, ev({ type: 'completed', ownerId: 'owner-2', jobId: 'j2', id: 'e2', at: D1 + 1000 }));
  t = rec(t, ev({ type: 'completed', ownerId: 'owner-2', jobId: 'j3', id: 'e3', at: D1 + 2000 }));
  const team = sharedTeamWork(t, D1_KEY);
  check('shared team total = 3 (summed verified)', team.totalCompleted === 3);
  check('shared team level from summed count', team.level === 1 && team.perk === 'depot trim');
}

console.log('\n----------------------------------------');
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASSED: all ${passed} checks`);
process.exit(0);
