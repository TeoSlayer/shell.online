#!/usr/bin/env node
// Local sandbox worker — the fixed, harmless demonstration task.
//
// Spawned by server.mjs as:  <node> sandbox-worker.mjs --task fixture-check
// It shows a real local process lifecycle that is explicitly NOT agent
// reasoning: build an in-memory fixture, run a few checks, compute a small
// digest, and finish with a validated summary. No network, no filesystem
// writes, no arbitrary shell, no user-supplied code. Pacing is fixed and
// labelled "demonstration pacing" — it is not a benchmark.
//
// Protocol: one JSON object per line on stdout. The parent parses these and
// never exposes raw stdout. Exits 0 only when the final report is valid.
import { createHash } from 'node:crypto';

const TASK = 'fixture-check';
const SEED = 20260921; // fixed, not user-supplied
const PACE_MS = 1200;  // fixed demonstration pacing (4 stages ~= 4.8s, < 6s)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// On SIGTERM, stop and exit shortly (a short, harmless cleanup grace). This is
// what lets the parent observe a real "child stopping" window before settlement.
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(130), 200).unref();
});

// Deterministic in-memory fixture. Never touches disk or the network.
function buildFixture(seed) {
  const items = [];
  let x = seed >>> 0;
  for (let i = 0; i < 8; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    items.push({ id: `item-${i}`, value: x % 1000, ok: x % 2 === 0 });
  }
  return items;
}

function parseTask(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--task') return argv[i + 1];
  }
  return null;
}

function main() {
  if (parseTask(process.argv.slice(2)) !== TASK) {
    emit({ type: 'error', message: 'unknown task' });
    process.exit(2);
  }

  (async () => {
    // Stage 1: fixture
    const fixture = buildFixture(SEED);
    await sleep(PACE_MS);
    emit({ type: 'progress', stage: 'fixture', checks: 1 });

    // Stage 2: validate the fixture in memory
    const valid = fixture.every(
      (it) => Number.isInteger(it.value) && it.value >= 0 && it.value < 1000 && typeof it.id === 'string',
    );
    await sleep(PACE_MS);
    emit({ type: 'progress', stage: 'validate', checks: 2, valid });

    // Stage 3: small digest of the canonical fixture
    const canonical = fixture.map((it) => `${it.id}:${it.value}`).join('|');
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    await sleep(PACE_MS);
    emit({ type: 'progress', stage: 'digest', checks: 3 });

    // Stage 4: validated summary
    await sleep(PACE_MS);
    const ok = valid && digest.length === 16 && fixture.length === 8;
    emit({ type: 'final', ok, digest, checks: 4, items: fixture.length });
    process.exit(ok ? 0 : 1);
  })();
}

main();
