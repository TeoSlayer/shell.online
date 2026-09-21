// P01 regression gate: a 45s wait cancelled by a client abort at ~1s must free the grant's wait
// slot, so the NEXT same-grant wait is admitted (not "limit") and runs its full timeout.
//
// This is the client-visible half of the accepted P01 evidence (the server-side settle/registered
// trace was one-time and has been removed). Run N consecutive trials (default 20).

import { mcpCall } from "../lib.mjs";

export const name = "cancellation-gate";

export async function run(ctx) {
  const { evidence, config, createGrant, revokeAll } = ctx;
  const trials = config.trials;
  const bearer = await createGrant("harness-cancel", 900);
  try {
    for (let i = 1; i <= trials; i += 1) {
      const t0 = Date.now();
      // w1: a 45s wait the client gives up on after 1s (request abort).
      const w1 = await mcpCall(bearer, "shell_wait", { pattern: "NEVER", timeout_ms: 45000 }, { abortAfterMs: 1000 });
      const w1ms = Date.now() - t0;
      if (!w1.aborted) {
        evidence.fail(`trial ${i}: w1 did not abort as expected (status=${w1.status} reason=${w1.toolResult?.reason})`);
        return;
      }
      // w2: immediately, the same grant waits again. Must be ADMITTED (run its 500ms), not "limit".
      const t1 = Date.now();
      const w2 = await mcpCall(bearer, "shell_wait", { pattern: "NEVER", timeout_ms: 500 });
      const w2ms = Date.now() - t1;
      const admitted = w2.toolResult?.reason === "timeout";
      evidence.step(`trial ${i}`, { w1_aborted_ms: w1ms, w2_ms: w2ms, w2_reason: w2.toolResult?.reason ?? null, admitted });
      if (!admitted) {
        evidence.fail(`trial ${i}: w2 not admitted after cancellation (reason=${w2.toolResult?.reason} error=${w2.error})`);
        return;
      }
      // A "limit" rejection returns in well under 200ms; an admitted 500ms wait takes ~500ms.
      if (w2ms < 400) {
        evidence.fail(`trial ${i}: w2 returned too fast to have run its timeout (${w2ms}ms)`);
        return;
      }
    }
    evidence.step("gate", { trials, result: "all admitted after cancellation" });
  } finally {
    await revokeAll();
  }
}
