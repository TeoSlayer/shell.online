// Cursor validation through the live surface:
//   - a cursor at the current (epoch, offset) is valid: reset=false, no new text
//   - a cursor with a foreign epoch is stale: reset=true
//   - a cursor at the current epoch but an offset the model reports as current is not a reset
// The synthetic session emits a 1 Hz tick, so the offset advances between calls.

import { mcpCall } from "../lib.mjs";

export const name = "cursor-reset";

export async function run(ctx) {
  const { evidence, createGrant, revokeAll } = ctx;
  const bearer = await createGrant("harness-cursor", 120);
  try {
    // Baseline: read the current position (no cursor).
    const base = await mcpCall(bearer, "shell_output", {});
    if (base.error || !base.toolResult) return evidence.fail(`baseline shell_output failed: ${base.error}`);
    const { epoch, offset, reset: baseReset } = base.toolResult;
    evidence.step("baseline", { epoch, offset, reset: baseReset });
    if (baseReset !== false) return evidence.fail(`baseline unexpectedly reset`);
    if (typeof epoch !== "number" || typeof offset !== "number") return evidence.fail("baseline missing epoch/offset numbers");

    // At the exact current position: valid, empty, not a reset.
    const atCurrent = await mcpCall(bearer, "shell_output", { cursor: { epoch, offset } });
    evidence.step("at_current", { reset: atCurrent.toolResult?.reset, text_len: atCurrent.toolResult?.output?.length ?? null });
    if (atCurrent.error) return evidence.fail(`at_current error: ${atCurrent.error}`);
    if (atCurrent.toolResult?.reset !== false) return evidence.fail(`cursor at current position reported reset`);

    // A foreign epoch (one ahead): stale -> reset.
    const foreign = await mcpCall(bearer, "shell_output", { cursor: { epoch: epoch + 1, offset: 0 } });
    evidence.step("foreign_epoch", { epoch: epoch + 1, reset: foreign.toolResult?.reset });
    if (foreign.error) return evidence.fail(`foreign_epoch error: ${foreign.error}`);
    if (foreign.toolResult?.reset !== true) return evidence.fail(`foreign epoch did not report reset`);

    // One behind: also stale -> reset.
    const behind = await mcpCall(bearer, "shell_output", { cursor: { epoch: Math.max(0, epoch - 1), offset: 0 } });
    evidence.step("behind_epoch", { epoch: Math.max(0, epoch - 1), reset: behind.toolResult?.reset });
    if (behind.error) return evidence.fail(`behind_epoch error: ${behind.error}`);
    if (behind.toolResult?.reset !== true) return evidence.fail(`behind epoch did not report reset`);
  } finally {
    await revokeAll();
  }
}
