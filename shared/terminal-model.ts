// Ephemeral terminal model for the MCP observe surface. Holds a bounded decrypted output tail,
// a headless VT (to render a plain-text screen), and an in-memory epoch/offset cursor. It is the
// single shared model per live DO instance (not one buffer per MCP client) and is never written
// to DO storage: on hibernation/eviction the memory is discarded and the model is re-seeded from
// a fresh host snapshot with a new epoch. Terminal output is always untrusted content; screen and
// output text is sanitized (shared/mcp-sanitize) before it reaches an MCP client.
//
// Cursor contract (every output-bearing result):
//   epoch   — changes whenever the model is re-seeded/reset, and is reconstruction-unique (a fresh
//             model instance never reuses a prior instance's epoch);
//   offset  — monotonic character offset within the epoch;
//   reset   — the supplied cursor was unavailable/stale (epoch mismatch or trimmed away);
//   truncated — server/client output limits omitted text.
// Waits only match output after the supplied cursor; with no cursor they baseline at the current
// position and never match an old prompt by accident. A wait with no pattern waits for any new
// output; a wait with a pattern waits for new output containing that literal substring. Matching
// is done against the full (uncapped) history after the baseline, not the response-capped text.
import { Terminal } from "@xterm/headless";
import { StreamingSanitizer, StreamingUtf8Decoder, capUtf8, type SanitizeState } from "./mcp-sanitize";

export interface Cursor {
  epoch: number;
  offset: number;
}

export interface ScreenResult {
  text: string;
  epoch: number;
}

export interface OutputResult {
  text: string;
  epoch: number;
  offset: number;
  reset: boolean;
  truncated: boolean;
}

export type WaitReason = "matched" | "timeout" | "cancelled" | "reset";

export interface WaitResult {
  matched: boolean;
  text: string;
  epoch: number;
  offset: number;
  reset: boolean;
  truncated: boolean;
  reason: WaitReason;
}

export interface TerminalModelOptions {
  cols: number;
  rows: number;
  maxTailChars: number;
  maxOutputBytes: number;
}

interface WaitHandle {
  baseline: number;
  startEpoch: number;
  pattern: string | null;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  signal: AbortSignal;
  resolve: (result: WaitResult) => void;
}

export class TerminalModel {
  private readonly term: Terminal;
  private readonly maxTailChars: number;
  private readonly maxOutputBytes: number;
  private tail = "";
  private tailStart = 0;
  // The sanitizer state at the start of the retained tail (raw position tailStart). Carried across
  // trims so a sequence split by a trim is still consumed whole rather than leaking its payload.
  private tailStartState: SanitizeState = "ground";
  private offset = 0;
  private epochCounter: number;
  private readonly utf8 = new StreamingUtf8Decoder();
  private pendingVtWrites = 0;
  private vtDrained: Promise<void> | null = null;
  private vtDrainedResolve: (() => void) | null = null;
  private readonly pendingWaits = new Set<WaitHandle>();

  constructor(opts: TerminalModelOptions) {
    this.maxTailChars = opts.maxTailChars;
    this.maxOutputBytes = opts.maxOutputBytes;
    this.term = new Terminal({ allowProposedApi: true, cols: opts.cols, rows: opts.rows });
    // Reconstruction-unique epoch: a fresh model instance starts at a random epoch so two
    // independently seeded models never share an epoch (a stale cursor can't match a replacement).
    this.epochCounter = 1 + Math.floor(Math.random() * 0x7fffffff);
  }

  get epoch(): number {
    return this.epochCounter;
  }

  get currentOffset(): number {
    return this.offset;
  }

  // Append decrypted plaintext output. Advances the offset, extends the bounded tail, feeds the
  // VT (asynchronously), and checks pending waits. Synchronous with respect to tail/offset.
  append(plaintext: Uint8Array): void {
    const text = this.utf8.feed(plaintext);
    if (text.length === 0) return;
    this.tail += text;
    this.offset += text.length;
    if (this.tail.length > this.maxTailChars) {
      const excess = this.tail.length - this.maxTailChars;
      // The new tail boundary is `excess` chars in. Carry the sanitizer state across it by running
      // the dropped prefix from the old boundary state, so a sequence split by the trim is still
      // consumed whole (the retained tail may now begin mid-sequence).
      const probe = new StreamingSanitizer(this.tailStartState);
      probe.feed(this.tail.slice(0, excess));
      this.tailStartState = probe.currentState;
      this.tail = this.tail.slice(excess);
      this.tailStart += excess;
    }
    this.feedVt(text);
    this.checkWaits();
  }

  // The current rendered screen (visible viewport), sanitized. Awaits pending VT writes.
  async screen(): Promise<ScreenResult> {
    await this.awaitVtDrained();
    const buf = this.term.buffer.active;
    const start = buf.viewportY;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i += 1) {
      const line = buf.getLine(start + i);
      lines.push(line ? line.translateToString(true) : "");
    }
    return { text: new StreamingSanitizer().feed(lines.join("\n")), epoch: this.epoch };
  }

  // Bounded sanitized output after an optional cursor. The cursor must carry a valid epoch and
  // offset; a stale cursor (epoch mismatch or trimmed away) reports reset.
  output(cursor?: Cursor): OutputResult {
    const { text, reset, truncated } = this.textAfter(cursor);
    return { text, epoch: this.epoch, offset: this.offset, reset, truncated };
  }

  // Wait for new output (after the cursor, or after the current position with no cursor). With a
  // pattern, waits for new output containing that literal substring; without one, waits for any
  // new output. Settles on match, timeout, cancellation, or an epoch reset. An already-aborted
  // signal settles immediately as cancelled.
  wait(pattern: string | null, cursor: Cursor | undefined, timeoutMs: number, signal: AbortSignal): Promise<WaitResult> {
    if (signal.aborted) {
      return Promise.resolve(this.settleResult(null, "cancelled"));
    }
    const baseline = cursor?.offset ?? this.offset;
    const startEpoch = cursor?.epoch ?? this.epoch;
    const handle: WaitHandle = {
      baseline,
      startEpoch,
      pattern,
      timer: setTimeout(() => this.settleWait(handle, "timeout"), timeoutMs),
      onAbort: () => this.settleWait(handle, "cancelled"),
      signal,
      resolve: () => {},
    };
    const promise = new Promise<WaitResult>((resolve) => {
      handle.resolve = resolve;
      signal.addEventListener("abort", handle.onAbort, { once: true });
      this.pendingWaits.add(handle);
      this.checkWait(handle);
    });
    return promise;
  }

  // Follow the actual terminal grid (the connected viewers' negotiated grid) so the rendered
  // screen wraps at the same columns the host is really using. No-op if the grid is unchanged.
  resize(cols: number, rows: number): void {
    if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
  }

  // Re-seed after hibernation/eviction or a fresh snapshot: reset the VT, reset the streaming
  // decoders, and bump the epoch (reconstruction-unique). Pending waits are stale and settle as
  // "reset".
  reseed(): void {
    // xterm.write is asynchronous. Queue RIS behind pending writes instead
    // of resetting immediately and letting old bytes paint over the reset.
    // CAN first terminates an unfinished control string from the old stream.
    this.feedVt("\x18\x1bc");
    this.utf8.reset();
    this.tail = "";
    this.tailStart = 0;
    this.tailStartState = "ground";
    this.offset = 0;
    this.epochCounter += 1;
    for (const handle of [...this.pendingWaits]) this.settleWait(handle, "reset");
  }

  // Free the model (best-effort; eviction discards the rest). Pending waits settle as "cancelled".
  free(): void {
    for (const handle of [...this.pendingWaits]) this.settleWait(handle, "cancelled");
    this.term.dispose();
  }

  private feedVt(text: string): void {
    this.pendingVtWrites += 1;
    this.term.write(text, () => {
      this.pendingVtWrites -= 1;
      if (this.pendingVtWrites === 0 && this.vtDrainedResolve) {
        this.vtDrainedResolve();
        this.vtDrainedResolve = null;
        this.vtDrained = null;
      }
    });
  }

  private async awaitVtDrained(): Promise<void> {
    if (this.pendingVtWrites === 0) return;
    if (!this.vtDrained) {
      this.vtDrained = new Promise<void>((resolve) => {
        this.vtDrainedResolve = resolve;
      });
    }
    await this.vtDrained;
  }

  // The sanitized tail text after a cursor, with reset/truncated flags. The cursor is validated
  // as a complete (epoch, offset) pair: an epoch mismatch or a trimmed-away offset reports reset.
  // Sanitization is streaming (state carried across the slice boundary), and the result is capped
  // to a UTF-8 byte budget (not a character count).
  private textAfter(cursor?: Cursor): { text: string; reset: boolean; truncated: boolean } {
    let reset = false;
    let start = 0;
    if (cursor) {
      if (cursor.epoch !== this.epoch || cursor.offset < this.tailStart) {
        reset = true;
        start = 0;
      } else if (cursor.offset >= this.offset) {
        return { text: "", reset: false, truncated: false };
      } else {
        start = cursor.offset - this.tailStart;
      }
    }
    const sanitized = this.sanitizeFrom(start);
    const { text, truncated: capped } = capUtf8(sanitized, this.maxOutputBytes);
    const trimmed = !cursor && this.tailStart > 0;
    return { text, reset, truncated: capped || trimmed };
  }

  // The full (uncapped) sanitized history after a baseline, for wait matching. Sanitization is
  // streaming (state carried across the boundary).
  private historyAfter(baseline: number): string {
    const start = Math.max(0, Math.min(baseline - this.tailStart, this.tail.length));
    return this.sanitizeFrom(start);
  }

  // Sanitize the retained tail from a (tail-relative) start position, resuming the parser at the
  // boundary state (tailStartState) so a sequence split across the tail start or the slice start is
  // consumed whole rather than leaking its payload.
  private sanitizeFrom(start: number): string {
    const before = this.tail.slice(0, start);
    const after = this.tail.slice(start);
    const sanitizer = new StreamingSanitizer(this.tailStartState);
    sanitizer.feed(before); // advance parser state to the slice boundary (discard output)
    return sanitizer.feed(after);
  }

  // Whether there is any new raw output after a baseline (for a pattern-less wait).
  private hasNewOutput(baseline: number): boolean {
    return this.offset > baseline;
  }

  private checkWaits(): void {
    for (const handle of this.pendingWaits) this.checkWait(handle);
  }

  private checkWait(handle: WaitHandle): void {
    if (!this.pendingWaits.has(handle)) return;
    // A stale cursor (epoch mismatch or trimmed away) settles the wait as reset.
    if (handle.startEpoch !== this.epoch || handle.baseline < this.tailStart) {
      this.settleWait(handle, "reset");
      return;
    }
    if (handle.pattern === null) {
      // No pattern: settle as soon as any new output arrives after the baseline.
      if (this.hasNewOutput(handle.baseline)) this.settleWait(handle, "matched");
      return;
    }
    // With a pattern: match against the full (uncapped) history after the baseline.
    if (this.historyAfter(handle.baseline).includes(handle.pattern)) this.settleWait(handle, "matched");
  }

  private settleWait(handle: WaitHandle, reason: WaitReason): void {
    if (!this.pendingWaits.has(handle)) return;
    this.pendingWaits.delete(handle);
    clearTimeout(handle.timer);
    handle.signal.removeEventListener("abort", handle.onAbort);
    handle.resolve(this.settleResult(handle, reason));
  }

  // Build a wait result: the (response-capped) sanitized text after the baseline, plus the flags.
  private settleResult(handle: WaitHandle | null, reason: WaitReason): WaitResult {
    const baseline = handle?.baseline ?? this.offset;
    const startEpoch = handle?.startEpoch ?? this.epoch;
    const reset = startEpoch !== this.epoch || baseline < this.tailStart;
    const start = reset ? 0 : Math.max(0, Math.min(baseline - this.tailStart, this.tail.length));
    const sanitized = this.sanitizeFrom(start);
    const { text, truncated } = capUtf8(sanitized, this.maxOutputBytes);
    return {
      matched: reason === "matched",
      text,
      epoch: this.epoch,
      offset: this.offset,
      reset,
      truncated,
      reason,
    };
  }
}
