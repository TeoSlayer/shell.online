// Wait limits (distinct from the request-concurrency caps):
//   - MCP_MAX_WAITS_PER_GRANT = 1: a second concurrent wait on the same grant is "limit".
//   - MCP_MAX_WAITS_PER_SESSION = 8: the session wait budget. NOTE: this is SHADOWED by
//     MAX_GRANTS_PER_RUN = 8 (a run can hold at most 8 live grants) combined with the 1/grant
//     wait limit — so at most 8 waits can ever be in flight (1 per grant x 8 grants). The 9th
//     in-flight wait is unreachable: a 9th grant is rejected (409 "too many grants"), and a 2nd
//     wait on an existing grant hits the per-grant limit first. This case verifies all of that.
// A "limit" is a normal (non-error) result: the call is admitted, returns reason "limit" quickly,
// and does not consume a wait slot. After the held waits settle, new waits are admitted again.

import { mcpCall } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = "wait-limits";

export async function run(ctx) {
  const { evidence, createGrant, revokeAll } = ctx;

  // --- 1/grant: a second concurrent wait on the same grant is "limit" -----------------------
  const g0 = await createGrant("harness-wl-0", 120);
  const w0 = mcpCall(g0, "shell_wait", { pattern: "NEVER", timeout_ms: 45000 }, { abortAfterMs: 8000 });
  await sleep(1500); // w0 in-flight
  const w1 = await mcpCall(g0, "shell_wait", { pattern: "NEVER", timeout_ms: 45000 });
  evidence.step("per_grant", { w1_reason: w1.toolResult?.reason ?? null, w1_ms: w1.ms });
  if (w1.toolResult?.reason !== "limit") {
    evidence.fail(`per_grant: second concurrent wait expected 'limit', got ${w1.toolResult?.reason}`);
  }
  if (w1.ms > 1000) evidence.fail(`per_grant: 'limit' should return quickly, took ${w1.ms}ms`);

  // --- session max: fill all 8 grant slots with in-flight waits (the reachable maximum) -----
  const waiters = [{ g: g0, w: w0 }];
  for (let i = 1; i < 8; i += 1) {
    const g = await createGrant(`harness-wl-${i}`, 120);
    waiters.push({ g, w: mcpCall(g, "shell_wait", { pattern: "NEVER", timeout_ms: 45000 }, { abortAfterMs: 8000 }) });
  }
  await sleep(1500); // all 8 in-flight
  const inFlight = waiters.length;
  evidence.step("session_max", { in_flight_waits: inFlight, note: "1 wait per grant x 8 grants = the reachable maximum" });

  // A 2nd wait on any grant is "limit" (per-grant), confirming no 9th in-flight wait is reachable.
  const wSecond = await mcpCall(g0, "shell_wait", { pattern: "NEVER", timeout_ms: 45000 });
  evidence.step("second_at_max", { reason: wSecond.toolResult?.reason ?? null });
  if (wSecond.toolResult?.reason !== "limit") {
    evidence.fail(`second_at_max: expected 'limit' at the session maximum, got ${wSecond.toolResult?.reason}`);
  }

  // The binding constraint: a 9th live grant is rejected (the session wait limit is shadowed).
  let ninthGrantError = null;
  try {
    await createGrant("harness-wl-ninth", 120);
    evidence.fail("grant_cap: expected the 9th grant to be rejected, but it succeeded");
  } catch (err) {
    ninthGrantError = String(err);
  }
  evidence.step("grant_cap_binding", { ninth_grant_rejected: /too many grants/.test(ninthGrantError ?? "") });
  if (!/too many grants/.test(ninthGrantError ?? "")) {
    evidence.fail(`grant_cap: 9th grant rejection was not 'too many grants' (got: ${ninthGrantError})`);
  }

  // --- released: after the held waits settle, a new wait is admitted -------------------------
  await Promise.allSettled(waiters.map((x) => x.w)); // self-abort at 8s
  await sleep(500);
  const wAfter = await mcpCall(g0, "shell_wait", { pattern: "NEVER", timeout_ms: 500 });
  evidence.step("released", { reason: wAfter.toolResult?.reason ?? null });
  if (wAfter.toolResult?.reason === "limit") {
    evidence.fail("released: wait still limited after all held waits settled");
  }

  await revokeAll();
}
