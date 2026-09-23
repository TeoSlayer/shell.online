// Local sandbox job store — in-memory, bounded, loopback-only.
//
// Owns the lifecycle of demonstration jobs: admission (idempotent by
// operationId, one per drone, at most two active), spawning the fixed worker,
// ordered event emission, validated completion, cancellation, and cleanup on
// shutdown. No network, no credentials, no arbitrary command execution.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const DRONE_ID = /^drone-[0-9]{1,4}$/;
export const ORIGIN_KINDS = new Set(['owner', 'drone', 'external_mcp']);
const STAGES = new Set(['fixture', 'validate', 'digest', 'summary']);
const DIGEST = /^[0-9a-f]{16}$/;

const MAX_ACTIVE = 2;
const MAX_COMPLETED = 128;
const COMPLETED_TTL_MS = 15 * 60 * 1000;
const RUNTIME_MAX_MS = 10 * 1000;
const MAX_EVENTS = 32;
const STDOUT_LINE_CAP = 8192;    // bound a single un-terminated stdout line
const SIGKILL_GRACE_MS = 500;    // SIGTERM -> SIGKILL fallback

const isTerminal = (status) => status === 'completed' || status === 'failed' || status === 'cancelled';

export class SandboxJobs {
  constructor({ workerScript, execPath }) {
    this.workerScript = workerScript;
    this.execPath = execPath;
    this.jobs = new Map();        // jobId -> job
    this.byOperation = new Map(); // operationId -> jobId (idempotency, spans terminal)
    this.byDrone = new Map();     // droneId -> jobId (active only)
  }

  activeCount() {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'accepted' || job.status === 'running') n += 1;
    }
    return n;
  }

  get(jobId) {
    return this.jobs.get(jobId) ?? null;
  }

  // Admit a job. Returns { job } on success (existing: true for idempotent
  // re-admission) or { error: 'conflict' | 'capacity' }.
  admit({ operationId, droneId, task, origin }) {
    const existingId = this.byOperation.get(operationId);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (!existing) return { error: 'conflict' };
      const same = existing.droneId === droneId
        && existing.task === task
        && existing.origin.kind === origin.kind
        && existing.origin.id === origin.id;
      return same ? { job: existing, existing: true } : { error: 'conflict' };
    }

    const droneJobId = this.byDrone.get(droneId);
    if (droneJobId) {
      const dj = this.jobs.get(droneJobId);
      if (dj && (dj.status === 'accepted' || dj.status === 'running')) return { error: 'conflict' };
    }
    if (this.activeCount() >= MAX_ACTIVE) return { error: 'capacity' };

    const job = {
      jobId: randomUUID(),
      operationId,
      droneId,
      task,
      origin,
      status: 'accepted',
      createdAt: Date.now(),
      completedAt: null,
      events: [],
      child: null,
      runtimeTimer: null,
      finalReport: null,
      // Settle intent: null while running, else { kind: 'cancelled' } or
      // { kind: 'failed', stage }. The terminal event is emitted only on actual
      // child close, never at the moment the kill is requested.
      settle: null,
    };
    this.jobs.set(job.jobId, job);
    this.byOperation.set(operationId, job.jobId);
    this.byDrone.set(droneId, job.jobId);
    this.pushEvent(job, 'accepted', {});
    return { job };
  }

  pushEvent(job, type, detail) {
    if (job.events.length >= MAX_EVENTS) return;
    job.events.push({
      id: randomUUID(),
      jobId: job.jobId,
      droneId: job.droneId,
      type,
      source: 'local-sandbox',
      at: Date.now(),
      detail,
    });
  }

  start(job) {
    const child = spawn(this.execPath, [this.workerScript, '--task', job.task], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.child = child;

    child.on('spawn', () => {
      if (job.status === 'accepted') {
        job.status = 'running';
        this.pushEvent(job, 'started', {});
      }
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      // Ignore child output once a settle intent is set or the job is terminal:
      // late stdout must never emit an output event after cancellation.
      if (job.settle || isTerminal(job.status)) return;
      stdout += chunk.toString('utf8');
      // Bound the line buffer so a runaway (newline-less) stream cannot grow it
      // without limit, even for the fixed fixture task.
      if (stdout.length > STDOUT_LINE_CAP) {
        if (stdout.indexOf('\n') === -1) { stdout = ''; return; }
      }
      let idx;
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (job.settle || isTerminal(job.status)) return;
        if (line) this.handleChildLine(job, line);
      }
    });
    child.stderr.on('data', () => {}); // drained, never exposed

    child.on('error', () => {
      // A spawn error means there is no running process to wait on; settle now.
      if (isTerminal(job.status)) return;
      if (!job.settle) job.settle = { kind: 'failed', stage: 'spawn_error' };
      this.signalChild(job);
      this.finish(job, 'failed', { stage: 'spawn_error' });
    });
    child.on('close', (code) => {
      if (job.runtimeTimer) clearTimeout(job.runtimeTimer);
      if (isTerminal(job.status)) return;
      // The terminal is decided only here, on actual child settlement.
      if (job.settle) {
        if (job.settle.kind === 'cancelled') this.finish(job, 'cancelled', {});
        else this.finish(job, 'failed', { stage: job.settle.stage });
      } else if (code === 0) {
        const report = job.finalReport;
        if (this.validReport(report)) this.finish(job, 'completed', { stage: 'summary', checks: report.checks });
        else this.finish(job, 'failed', { stage: 'invalid_report' });
      } else {
        this.finish(job, 'failed', { stage: 'exit', checks: Number.isInteger(code) ? code : 1 });
      }
    });

    job.runtimeTimer = setTimeout(() => {
      if (job.status === 'accepted' || job.status === 'running') {
        if (!job.settle) job.settle = { kind: 'failed', stage: 'runtime_exceeded' };
        this.signalChild(job);
      }
    }, RUNTIME_MAX_MS);
    if (job.runtimeTimer.unref) job.runtimeTimer.unref();
  }

  handleChildLine(job, line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'progress') {
      const detail = {};
      if (typeof obj.stage === 'string' && STAGES.has(obj.stage)) detail.stage = obj.stage;
      if (Number.isSafeInteger(obj.checks) && obj.checks > 0) detail.checks = obj.checks;
      this.pushEvent(job, 'output', detail);
    } else if (obj.type === 'final') {
      job.finalReport = obj;
    }
  }

  // Completion is only valid on an actual zero exit plus a well-formed final
  // report. Output alone (or a non-zero exit) can never imply success.
  validReport(report) {
    if (!report || typeof report !== 'object') return false;
    if (report.type !== 'final' || report.ok !== true) return false;
    if (typeof report.digest !== 'string' || !DIGEST.test(report.digest)) return false;
    if (!Number.isSafeInteger(report.checks) || report.checks <= 0) return false;
    return true;
  }

  finish(job, status, detail) {
    if (isTerminal(job.status)) return;
    job.status = status;
    job.completedAt = Date.now();
    this.pushEvent(job, status, detail);
    this.byDrone.delete(job.droneId);
    this.prune();
  }

  // Cancel records the intent and signals the child, but does NOT settle the
  // job: the terminal `cancelled` event and the slot release happen on actual
  // child close. The POST may report `cancelling`; the UI observes the terminal
  // on the event stream.
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { error: 'not_found' };
    if (isTerminal(job.status)) return { job, already: true, status: job.status };
    if (!job.settle) {
      job.settle = { kind: 'cancelled' };
      this.signalChild(job);
    }
    return { job, already: false, status: 'cancelling' };
  }

  // A kill request is not proof of exit. Keep admission occupied until the
  // actual close event, even if the process fails to stop promptly.
  signalChild(job) {
    if (job.runtimeTimer) clearTimeout(job.runtimeTimer);
    const child = job.child;
    if (child && !child.killed) {
      child.killed = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, SIGKILL_GRACE_MS);
      if (t.unref) t.unref();
    }
  }

  // Bound terminal records: drop anything past the TTL, then cap at the max by
  // evicting the oldest completed.
  prune() {
    const now = Date.now();
    const drop = (job) => {
      this.jobs.delete(job.jobId);
      this.byOperation.delete(job.operationId);
    };
    for (const job of [...this.jobs.values()]) {
      if (isTerminal(job.status) && now - job.completedAt >= COMPLETED_TTL_MS) drop(job);
    }
    const terminal = [...this.jobs.values()].filter((j) => isTerminal(j.status));
    if (terminal.length > MAX_COMPLETED) {
      terminal.sort((a, b) => a.completedAt - b.completedAt);
      for (const job of terminal.slice(0, terminal.length - MAX_COMPLETED)) drop(job);
    }
  }

  // Shutdown also preserves truthful settlement: close emits cancellation.
  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.status === 'accepted' || job.status === 'running') {
        if (!job.settle) job.settle = { kind: 'cancelled' };
        this.signalChild(job);
      }
    }
  }
}
