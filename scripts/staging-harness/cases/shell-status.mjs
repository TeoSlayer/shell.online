// shell_status: bounded structured state + the read-only annotation fix (P03).
//   - the payload carries the expected fields and NO secrets (no bearer, no session id, no URL)
//   - tools/list exposes readOnlyHint on ALL four observe tools (no per-tool approval workaround)

import { mcpCall, mcpToolsList } from "../lib.mjs";

export const name = "shell-status";

export async function run(ctx) {
  const { evidence, createGrant, revokeAll } = ctx;
  const bearer = await createGrant("harness-status", 120);
  try {
    // 1. Payload shape + no secrets.
    const res = await mcpCall(bearer, "shell_status", {});
    if (res.error || !res.toolResult) return evidence.fail(`shell_status failed: ${res.error}`);
    const p = res.toolResult;
    evidence.step("payload", {
      keys: Object.keys(p).sort(),
      grant_scopes: p.grant?.scopes,
      has_expires_at: typeof p.grant?.expires_at === "string",
      run_state: p.run?.state,
      fresh_model_available: p.run?.fresh_model_available,
    });
    for (const key of ["status", "label", "human_viewers", "active_controllers", "grant", "run"]) {
      if (!(key in p)) return evidence.fail(`payload missing key: ${key}`);
    }
    if (!Array.isArray(p.grant?.scopes)) return evidence.fail("grant.scopes not an array");
    if (typeof p.grant?.expires_at !== "string") return evidence.fail("grant.expires_at not a string");
    if (typeof p.run?.fresh_model_available !== "boolean") return evidence.fail("run.fresh_model_available not a boolean");
    // No secrets in the payload.
    const flat = JSON.stringify(p);
    if (flat.includes(bearer)) return evidence.fail("payload contains the bearer");
    if (flat.includes(ctx.session.session_id)) return evidence.fail("payload contains the session id");
    if (flat.includes("http")) return evidence.fail("payload contains a URL");

    // 2. Read-only annotations on all observe tools (live tools/list). The secret registry is
    // passed so a tools/list failure can never leak a bearer or nested-session credential.
    const tools = await mcpToolsList(bearer, ctx.secrets);
    const byName = new Map(tools.map((t) => [t.name, t]));
    evidence.step("annotations", {
      tools: Object.fromEntries(
        ["shell_status", "shell_screen", "shell_output", "shell_wait"].map((n) => [
          n,
          byName.get(n)?.annotations ?? null,
        ]),
      ),
    });
    for (const name of ["shell_status", "shell_screen", "shell_output", "shell_wait"]) {
      const tool = byName.get(name);
      if (!tool) return evidence.fail(`tools/list missing ${name}`);
      if (tool.annotations?.readOnlyHint !== true) {
        return evidence.fail(`${name} missing readOnlyHint: true (got ${JSON.stringify(tool.annotations)})`);
      }
      if (tool.annotations?.openWorldHint !== false) {
        return evidence.fail(`${name} missing openWorldHint: false (got ${JSON.stringify(tool.annotations)})`);
      }
    }
  } finally {
    await revokeAll();
  }
}
