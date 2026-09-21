// Bounded staging test harness runner (P02).
//
// Usage:
//   node scripts/staging-harness/run.mjs [case ...] [--trials N]
//
// Cases (each isolated: own session, own grants, finally-block cleanup):
//   cancellation-gate         P01 regression: 45s wait cancelled at 1s, next same-grant wait admitted
//   wait-timeout              full 45s wait runs to timeout
//   cursor-reset              stale/foreign cursors report reset; current cursor does not
//   revoke-expiry             revoked and expired grants are rejected (401), live grants pass
//   wait-limits               1 concurrent wait/grant; session max (8) + grant-cap binding
//   request-concurrency-grant 4 concurrent requests/grant; held bodies + released slots
//   request-concurrency-session 16 concurrent requests/session (8 held waits + burst)
//   shell-status              status payload shape + read-only annotations on all observe tools
//
// All: node scripts/staging-harness/run.mjs
//
// Each case creates its own session and cleans up in a finally block, so cases are
// independently runnable and order-independent. Evidence is written to docs/evidence/
// (sanitized; a bearer scan guards the write). Exit code 0 iff every case passed.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STAGING,
  SYNTHETIC_COMMAND,
  createSession,
  grant,
  revokeAll,
  cleanupSession,
  identity,
  Evidence,
  buildCli,
  redact,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(HERE, "..", "..", "..", "docs", "evidence");

const CASES = {
  "cancellation-gate": () => import("./cases/cancellation-gate.mjs"),
  "wait-timeout": () => import("./cases/wait-timeout.mjs"),
  "cursor-reset": () => import("./cases/cursor-reset.mjs"),
  "revoke-expiry": () => import("./cases/revoke-expiry.mjs"),
  "wait-limits": () => import("./cases/wait-limits.mjs"),
  "request-concurrency-grant": () => import("./cases/request-concurrency-grant.mjs"),
  "request-concurrency-session": () => import("./cases/request-concurrency-session.mjs"),
  "shell-status": () => import("./cases/shell-status.mjs"),
};

export function parseArgs(argv) {
  const args = { cases: [], trials: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--trials") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--trials requires a positive integer, got: ${raw ?? "(missing)"}`);
      args.trials = n;
    } else if (a === "--all") args.cases = Object.keys(CASES);
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else if (CASES[a]) args.cases.push(a);
    else throw new Error(`unknown case: ${a} (available: ${Object.keys(CASES).join(", ")}, --all)`);
  }
  if (args.cases.length === 0) args.cases = Object.keys(CASES);
  return args;
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: node scripts/staging-harness/run.mjs [case ...] [--trials N] [--all]");
    console.log("Cases: " + Object.keys(CASES).join(", "));
    console.log("Runs synthetic sessions on the pinned staging origin; never production.");
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  console.log(`staging harness: ${args.cases.join(", ")} (trials=${args.trials})`);
  console.log(`target: ${STAGING}`);
  buildCli();
  const ident = await identity();
  console.log(
    `identity: git=${ident.git.rev.slice(0, 12)} dirty=${ident.git.dirtyFiles} deployed=${ident.deployedVersion} flags=${ident.runtimeFlags.join(",") || "none"}`,
  );

  const results = [];
  for (const name of args.cases) {
    const mod = await CASES[name]();
    const session = await createSession();
    // The COMPLETE secret registry for this case: the runner session's creds, every bearer minted,
    // and every cold session's creds. Every output boundary (evidence write, console) redacts with
    // this full set, so a nested (cold) session credential can never leak.
    const secrets = [];
    if (session.share_url) secrets.push(session.share_url);
    if (session.e2ee_password) secrets.push(session.e2ee_password);
    // Cold sessions tracked for cleanup, each with a verify bearer (the first grant minted on it)
    // so cleanup can VERIFY the credentials no longer authorize.
    const coldSessions = []; // { session, verifyBearer }
    let runnerVerifyBearer = null;
    const evidence = new Evidence(name, ident);
    const ctx = {
      session,
      secrets,
      evidence,
      config: { trials: args.trials },
      // Grant on the runner's session; the bearer is registered in the secret registry and the
      // first one is kept as the cleanup verification bearer.
      createGrant: async (label, ttl = 900) => {
        const bearer = await grant(session.session_id, label, "observe", ttl);
        secrets.push(bearer);
        if (!runnerVerifyBearer) runnerVerifyBearer = bearer;
        return bearer;
      },
      // An isolated cold session: its creds are registered in the secret registry and it is
      // tracked for runner cleanup (revoked + killed + verified in the finally).
      createColdSession: async (command = SYNTHETIC_COMMAND) => {
        const cold = await createSession(command);
        if (cold.share_url) secrets.push(cold.share_url);
        if (cold.e2ee_password) secrets.push(cold.e2ee_password);
        coldSessions.push({ session: cold, verifyBearer: null });
        return cold;
      },
      // Grant on a cold session; the bearer is registered in the secret registry and the first
      // one is kept as that session's cleanup verification bearer.
      createColdGrant: async (sessionId, label, ttl = 900) => {
        const bearer = await grant(sessionId, label, "observe", ttl);
        secrets.push(bearer);
        const entry = coldSessions.find((c) => c.session.session_id === sessionId);
        if (entry && !entry.verifyBearer) entry.verifyBearer = bearer;
        return bearer;
      },
      revokeAll: () => revokeAll(session.session_id),
    };
    const started = Date.now();
    console.log(`\n=== ${name} (session ${session.session_id}) ===`);
    const cleanupErrors = [];
    const cleanupUncertain = [];
    try {
      await mod.run(ctx);
    } catch (err) {
      evidence.fail(`case threw: ${err?.stack ?? err}`);
    } finally {
      // Cleanup is centralized here and VERIFIED: the runner session AND every cold session are
      // revoked + killed (bounded retries), then verified (the credentials no longer authorize).
      // A timeout is NOT assumed to mean the revocation failed or succeeded — the verification
      // probe decides, and an ambiguous result is reported as uncertain (not a silent pass/fail).
      const record = (label, res) => {
        for (const n of res.notes) evidence.step(`cleanup_${label}`, { note: n });
        if (res.verified) return;
        if (res.notes.some((n) => n.includes("still LIVE"))) {
          cleanupErrors.push(`${label} session still LIVE after cleanup (credentials still authorize)`);
        } else {
          cleanupUncertain.push(`${label} session cleanup UNCERTAIN (could not verify credentials stopped authorizing)`);
        }
      };
      record("runner", await cleanupSession(session.session_id, { verifyBearer: runnerVerifyBearer }));
      for (const { session: cold, verifyBearer } of coldSessions) {
        record(`cold ${cold.session_id}`, await cleanupSession(cold.session_id, { verifyBearer }));
      }
    }
    if (cleanupErrors.length > 0) evidence.fail(`cleanup failed: ${cleanupErrors.join("; ")}`);
    for (const u of cleanupUncertain) evidence.inconclusive(`cleanup: ${u}`);
    const ms = Date.now() - started;
    // An evidence-write failure (e.g. a secret leaked) is a real failure, not a warning. The full
    // secret registry (including nested cold-session creds) guards the write.
    let file = null;
    try {
      file = evidence.write(EVIDENCE_DIR, secrets);
    } catch (err) {
      evidence.fail(`evidence write failed: ${err?.message ?? err}`);
    }
    // pass / fail / inconclusive: a case that could not fully exercise its target (or whose cleanup
    // is uncertain) is inconclusive — neither a product failure nor a pass.
    const result = !evidence.ok ? "fail" : evidence.inconclusiveOnly ? "inconclusive" : "pass";
    results.push({ case: name, result, ms, failures: evidence.data.failures, inconclusive: evidence.data.inconclusive });
    console.log(`  ${result.toUpperCase()} in ${(ms / 1000).toFixed(1)}s${file ? ` — evidence: ${file}` : ""}`);
    // Every output boundary redacts with the COMPLETE secret registry (not just the built-in
    // URL/e2ee stripping), so a nested-session credential can never reach the console.
    for (const f of evidence.data.failures) console.log(`  failure: ${redact(f, secrets).slice(0, 300)}`);
    for (const u of evidence.data.inconclusive) console.log(`  inconclusive: ${redact(u, secrets).slice(0, 300)}`);
  }

  console.log("\n=== summary ===");
  for (const r of results) console.log(`  ${r.result.toUpperCase().padEnd(4)} ${r.case} (${(r.ms / 1000).toFixed(1)}s)`);
  const failed = results.filter((r) => r.result === "fail");
  const inconclusive = results.filter((r) => r.result === "inconclusive");
  if (inconclusive.length > 0) {
    console.log(`\n${inconclusive.length} case(s) INCONCLUSIVE (target not fully exercised or cleanup unverified — not a product failure)`);
  }
  if (failed.length > 0) {
    console.log(`${failed.length} case(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nno case(s) failed${inconclusive.length > 0 ? " (inconclusive cases do not fail the run)" : ""}`);
  }
}

// Run main() only when executed directly (not when imported by a test).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`harness error: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}
