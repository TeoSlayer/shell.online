// Revocation and expiry stop access without touching the human link:
//   - a live grant reads shell_status (200 + payload)
//   - after revoke-all, the same bearer is rejected (401)
//   - a short-TTL grant that expires is rejected (401) once past its deadline
// The session (and its human share link) is unaffected; only the grant's access ends.

import { mcpCall } from "../lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = "revoke-expiry";

export async function run(ctx) {
  const { evidence, session, createGrant, revokeAll } = ctx;

  // 1. Live grant passes.
  const live = await createGrant("harness-revoke", 900);
  const ok = await mcpCall(live, "shell_status", {});
  evidence.step("live", { status: ok.status, hasPayload: !!ok.toolResult, scopes: ok.toolResult?.grant?.scopes });
  if (ok.error || !ok.toolResult) return evidence.fail(`live grant shell_status failed: ${ok.error}`);
  if (!Array.isArray(ok.toolResult?.grant?.scopes)) return evidence.fail("live payload missing grant.scopes");

  // 2. Revoke -> the same bearer is rejected.
  await revokeAll();
  const revoked = await mcpCall(live, "shell_status", {});
  evidence.step("revoked", { status: revoked.status, error: revoked.error });
  if (revoked.status !== 401) return evidence.fail(`revoked grant expected 401, got ${revoked.status}`);

  // 3. Expiry -> a fresh short-TTL grant passes, then is rejected after its deadline.
  const short = await createGrant("harness-expiry", 3);
  const before = await mcpCall(short, "shell_status", {});
  evidence.step("expiry_before", { status: before.status, hasPayload: !!before.toolResult });
  if (before.error || !before.toolResult) return evidence.fail(`pre-expiry shell_status failed: ${before.error}`);
  await sleep(5000);
  const after = await mcpCall(short, "shell_status", {});
  evidence.step("expiry_after", { status: after.status, error: after.error });
  if (after.status !== 401) return evidence.fail(`expired grant expected 401, got ${after.status}`);

  // The session itself is still alive (a new grant can still read it).
  const again = await createGrant("harness-regrant", 60);
  const regrant = await mcpCall(again, "shell_status", {});
  evidence.step("regrant", { status: regrant.status, hasPayload: !!regrant.toolResult });
  if (regrant.error || !regrant.toolResult) return evidence.fail(`session unreadable after revoke/expiry: ${regrant.error}`);
}
