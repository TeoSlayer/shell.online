// A full 45s wait (the maximum) runs to its timeout: the long-poll is admitted, holds for the
// whole window, and settles with reason "timeout" (no match, no cancel, no reset).

import { mcpCall } from "../lib.mjs";

export const name = "wait-timeout";

export async function run(ctx) {
  const { evidence, createGrant, revokeAll } = ctx;
  const bearer = await createGrant("harness-wait-timeout", 120);
  try {
    const t0 = Date.now();
    const res = await mcpCall(bearer, "shell_wait", { pattern: "NEVER_MATCH_45S", timeout_ms: 45000 }, { timeoutMs: 60000 });
    const ms = Date.now() - t0;
    evidence.step("wait45", { ms, reason: res.toolResult?.reason ?? null, matched: res.toolResult?.matched ?? null });
    if (res.error) return evidence.fail(`wait45 error: ${res.error}`);
    if (res.toolResult?.reason !== "timeout") return evidence.fail(`expected reason=timeout, got ${res.toolResult?.reason}`);
    if (res.toolResult?.matched !== false) return evidence.fail(`expected matched=false, got ${res.toolResult?.matched}`);
    if (ms < 44000 || ms > 50000) return evidence.fail(`45s wait settled out of window (${ms}ms)`);
  } finally {
    await revokeAll();
  }
}
