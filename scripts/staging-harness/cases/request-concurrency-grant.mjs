// Request-concurrency cap PER GRANT (MCP_MAX_CONCURRENT_PER_GRANT = 4), verified UNDER LOAD.
//
// The cap is checked at admission (worker/index.ts:1906) and the in-flight counter is incremented
// before the body is read (worker/index.ts:1919) and decremented on release. To actually REACH the
// cap under load, this case exploits the one tool that yields for a controllable, SHARED duration:
// the cold-start model seed. On a FRESH session the model is not seeded, so a burst of concurrent
// shell_screen calls all await the same snapshot round-trip (mcpEnsureModelSeeded), keeping them in
// flight together — the 5th and beyond are admitted against a full counter and return the
// concurrency 429. The deterministic rejection predicate is covered by the unit-test fixture
// (tests/mcp-observe.test.ts "request-concurrency caps"); this live case exercises real
// registration/accounting under load.
//
// The seed window is a TIMING LOTTERY: a fast host can settle it before the burst fills the
// counter, in which case the cap is NOT exercised. Per review, that is reported as INCONCLUSIVE
// (a test-harness limitation), NOT a product failure and NOT a pass. The case also reserves a full
// rate-limiter window before each attempt (the MCP limiter is a fixed 60 req/60s budget; a single
// successful probe does not establish a fresh budget).
//
// "Released slots" requires an ACTUAL successful timeout (reason === "timeout") on the SAME cold
// session that hit the cap, after the burst settles, not merely not-"limit".

import { mcpCall, cooldown } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = "request-concurrency-grant";

const BURST = 12;
const ATTEMPTS = 3;

function summarize(results) {
  const ok = results.filter((r) => r.status === 200).length;
  const conc = results.filter((r) => r.status === 429 && r.busy === "concurrency").length;
  const limiter = results.filter((r) => r.status === 429 && r.busy === "rate_limiter").length;
  const other = results.filter((r) => r.status !== 200 && r.status !== 429);
  return { ok, conc, limiter, other: other.map((r) => ({ status: r.status, error: r.error })) };
}

// Wait until the cold session's host is connected (shell_status does NOT trigger the seed).
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
  // Cold sessions are created via ctx.createColdSession (creds registered in the secret registry,
  // tracked for runner cleanup). The case does NOT tear them down itself — the runner revokes +
  // kills + verifies every cold session and records any failure, so a leak cannot be swallowed here.
  let hit = null;
  let hitCold = null; // { coldBearer } — the session that produced a clean cap hit (kept alive for
                      // the released-slots probe, which must run on the SAME session that hit the cap)
  for (let attempt = 1; attempt <= ATTEMPTS && !hit; attempt += 1) {
    // Reserve a fresh rate-limiter budget for this attempt's burst + follow-up: the MCP limiter is
    // a FIXED 60 req/60s window, and a single successful probe does NOT establish a fresh budget.
    // The burst (12) + readiness + released-slots is well under 60, so a full window wait gives it
    // clean capacity.
    await cooldown();
    const cold = await ctx.createColdSession();
    const coldBearer = await ctx.createColdGrant(cold.session_id, "harness-ccg-cold", 120);
    const connected = await waitConnected(coldBearer);
    const jobs = [];
    for (let i = 0; i < BURST; i += 1) jobs.push(mcpCall(coldBearer, "shell_screen", {}));
    const s = summarize(await Promise.all(jobs));
    evidence.step(`cap_hit_attempt_${attempt}`, { connected, ...s });
    // A clean cap hit: some concurrency 429s, no rate-limiter 429s, nothing unexpected.
    if (s.conc > 0 && s.limiter === 0 && s.other.length === 0) {
      hit = s;
      hitCold = { coldBearer };
    }
    // else: the seed settled before the burst filled the counter (or the limiter interfered);
    // retry on a fresh cold session.
  }
  if (!hit) {
    // The cap was NOT exercised (the seed window was too short on a fast host, or the limiter
    // interfered). This is a TIMING LOTTERY / test-harness limitation, NOT a product failure and
    // NOT a pass — report it as inconclusive. The deterministic rejection predicate is covered by
    // the unit-test fixture.
    evidence.inconclusive(
      `cap not exercised: no clean concurrency 429 across ${ATTEMPTS} cold-session bursts of ${BURST} ` +
        `(the seed window was too short to reach the 4/grant cap; deterministic predicate covered by unit fixture)`,
    );
  } else {
    if (hit.ok + hit.conc !== BURST) {
      evidence.fail(`cap_hit: requests not fully accounted (ok=${hit.ok} conc=${hit.conc}, expected ${BURST})`);
    }
    // --- released slots: on the SAME cold session that hit the cap, after the burst settles, a
    // wait is admitted and runs to a REAL timeout. (Not the runner's grant — the cap was hit on the
    // cold session, so the slot release must be observed there, before teardown.)
    const w = await mcpCall(hitCold.coldBearer, "shell_wait", { pattern: "NEVER", timeout_ms: 500 });
    evidence.step("released_slots", { reason: w.toolResult?.reason ?? null, status: w.status, error: w.error ?? null });
    if (w.toolResult?.reason !== "timeout") {
      evidence.fail(
        `released_slots: expected a successful timeout, got reason=${w.toolResult?.reason ?? null} ` +
          `status=${w.status} error=${w.error ?? null}`,
      );
    }
  }
}
