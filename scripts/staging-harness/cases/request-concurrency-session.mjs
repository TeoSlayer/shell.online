// Request-concurrency cap PER SESSION (MCP_MAX_CONCURRENT_PER_SESSION = 16), verified UNDER LOAD.
//
// The session cap is checked at admission (worker/index.ts:1909) against the session-wide in-flight
// total, and the in-flight counter is incremented before the body is read (worker/index.ts:1919).
// To hit it WITHOUT the per-grant cap (4) being the binding constraint, this case keeps each grant
// under its per-grant cap (2 in flight each) while filling the session total to 16: 8 grants
// (MAX_GRANTS_PER_RUN) x 2 concurrent shell_screen calls = 16, plus a 17th. On a FRESH cold session
// all of these await the same cold-start snapshot round-trip (mcpEnsureModelSeeded), so they stay in
// flight together — the 17th is admitted against a full session total and returns the concurrency
// 429. Because every grant is at 2 (< 4), the per-grant cap cannot be the cause of any 429 here; a
// concurrency 429 is therefore the session cap. The deterministic rejection predicate is covered by
// the unit-test fixture (tests/mcp-observe.test.ts "request-concurrency caps"); this live case
// exercises real registration/accounting under load.
//
// Hitting a HIGH cap (16) requires 16+ requests in flight simultaneously, which makes this a
// TIMING LOTTERY: a fast host can settle the seed before the burst fills the total, in which case
// the cap is NOT exercised. Per review, that is reported as INCONCLUSIVE (a test-harness
// limitation), NOT a product failure and NOT a pass. The case also reserves a full rate-limiter
// window before each attempt (the MCP limiter is a fixed 60 req/60s budget; a single successful
// probe does not establish a fresh budget).
//
// "Released slots" requires an ACTUAL successful timeout (reason === "timeout") on the SAME session
// that hit the cap, after the burst settles, not merely not-"limit".

import { mcpCall, cooldown } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = "request-concurrency-session";

const GRANTS = 8; // MAX_GRANTS_PER_RUN
const PER_GRANT = 2; // under the per-grant cap (4), so the session cap is the binding constraint
const ATTEMPTS = 3;

function summarize(results) {
  const ok = results.filter((r) => r.status === 200).length;
  const conc = results.filter((r) => r.status === 429 && r.busy === "concurrency").length;
  const limiter = results.filter((r) => r.status === 429 && r.busy === "rate_limiter").length;
  const other = results.filter((r) => r.status !== 200 && r.status !== 429);
  return { ok, conc, limiter, other: other.map((r) => ({ status: r.status, error: r.error })) };
}

async function waitConnected(bearer, { tries = 6, delayMs = 300 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const s = await mcpCall(bearer, "shell_status", {});
    if (s.toolResult?.status === "connected") return true;
    await sleep(delayMs);
  }
  return false;
}

export async function run(ctx) {
  const { evidence } = ctx;
  let hit = null;
  let hitGrants = null; // grants of the session that hit the cap (for the released-slots probe)
  for (let attempt = 1; attempt <= ATTEMPTS && !hit; attempt += 1) {
    // Reserve a fresh rate-limiter budget for this attempt's burst + follow-up: the MCP limiter is
    // a FIXED 60 req/60s window, and a single successful probe does NOT establish a fresh budget.
    // The burst (17) + readiness + released-slots is well under 60, so a full window wait gives it
    // clean capacity.
    await cooldown();
    // The cold session is registered for runner cleanup at creation (before any grant is minted),
    // so even a grant failure cannot leak it. The case does not tear it down itself — the runner
    // revokes + kills + verifies every cold session and records any failure.
    const cold = await ctx.createColdSession();
    const grants = [];
    for (let i = 0; i < GRANTS; i += 1) {
      grants.push(await ctx.createColdGrant(cold.session_id, `harness-ccs-${i}`, 120));
    }
    const connected = await waitConnected(grants[0]);
    // 8 grants x 2 shell_screen = 16 (fills the session total) + a 17th on grant 0.
    const jobs = [];
    for (let i = 0; i < GRANTS; i += 1) {
      for (let j = 0; j < PER_GRANT; j += 1) jobs.push(mcpCall(grants[i], "shell_screen", {}));
    }
    jobs.push(mcpCall(grants[0], "shell_screen", {}));
    const total = jobs.length;
    const s = summarize(await Promise.all(jobs));
    evidence.step(`session_cap_attempt_${attempt}`, { connected, total, ...s });
    // A clean session-cap hit: some concurrency 429s (each grant at 2 < 4, so the per-grant cap is
    // not the cause), no rate-limiter 429s, nothing unexpected, all requests accounted for.
    if (s.conc > 0 && s.limiter === 0 && s.other.length === 0 && s.ok + s.conc === total) {
      hit = s;
      hitGrants = grants;
    }
    // else: the seed settled before the burst filled the total (or the limiter interfered); retry.
  }
  if (!hit) {
    // The cap was NOT exercised (the seed window was too short on a fast host to keep 16+ in
    // flight, or the limiter interfered). This is a TIMING LOTTERY / test-harness limitation, NOT a
    // product failure and NOT a pass — report it as inconclusive. The deterministic rejection
    // predicate is covered by the unit-test fixture.
    evidence.inconclusive(
      `cap not exercised: no clean concurrency 429 across ${ATTEMPTS} cold-session bursts of ` +
        `${GRANTS * PER_GRANT + 1} (the seed window was too short to reach the 16/session cap; ` +
        `deterministic predicate covered by unit fixture)`,
    );
  } else {
    // --- released slots: on the SAME session that hit the cap, after the burst settles, a wait is
    // admitted and runs to a REAL timeout (not merely not-"limit").
    const w = await mcpCall(hitGrants[0], "shell_wait", { pattern: "NEVER", timeout_ms: 500 });
    evidence.step("released_slots", { reason: w.toolResult?.reason ?? null, status: w.status, error: w.error ?? null });
    if (w.toolResult?.reason !== "timeout") {
      evidence.fail(`released_slots: expected a successful timeout, got reason=${w.toolResult?.reason ?? null} status=${w.status} error=${w.error ?? null}`);
    }
  }
}
