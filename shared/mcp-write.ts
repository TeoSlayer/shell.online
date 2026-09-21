// Runtime-neutral shell_send write-contract logic: strict text/operation-id validation, the
// canonical fingerprint input, and the bounded at-most-once operation store. The DO
// (worker/index.ts) uses these to implement shell_send: strict validation, scope/read-only
// enforcement, durable at-most-once claims, and truthful host-acknowledged delivery status.
//
// This module carries no Worker-only APIs so it is unit-testable in isolation. The SHA-256
// fingerprint is computed by the caller (crypto.subtle) over `shellSendFingerprintInput`.

export const SEND_MAX_TEXT_BYTES = 8192;

// A UUID v4 (the operation_id): 8-4-4-4-12 hex, version nibble 4, variant [89ab].
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(id: string): boolean {
  return UUID_V4.test(id);
}

// Forbidden characters in shell_send text: NUL, every C0 control EXCEPT TAB (U+0009), and every
// C1 control. This rejects LF, CR, ESC, BEL, and the other controls, so the caller cannot smuggle
// a newline, a raw escape sequence, or a carriage return into the text; the only way to submit is
// the explicit `enter` flag.
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

// Validate shell_send text per the write contract. Returns an error message, or null if valid.
// `utf8` is injected so the test can supply a stub encoder.
export function validateShellSendText(text: string, utf8: (s: string) => Uint8Array): string | null {
  if (text.length === 0) return "text must be non-empty";
  const bytes = utf8(text);
  if (bytes.byteLength > SEND_MAX_TEXT_BYTES) return `text exceeds ${SEND_MAX_TEXT_BYTES} bytes`;
  if (FORBIDDEN_TEXT.test(text)) {
    return "text contains a forbidden control character (C0 except TAB, or C1)";
  }
  return null;
}

// The canonical fingerprint input: tool name + \x1f + the validated args (keys sorted, no
// whitespace), EXCLUDING the operation_id. The tool name is part of the fingerprint, so reusing an
// operation_id across two different tools (shell_send then shell_key) is a conflict, not a replay.
// `enter` sorts before `text`, so the normalized JSON is stable.
export function shellSendFingerprintInput(args: { text: string; enter: boolean }): string {
  const normalized = JSON.stringify({ enter: args.enter, text: args.text });
  return `shell_send\u001f${normalized}`;
}

// --- Durable at-most-once operation store ---

export type McpOpState = "claiming" | "dispatched" | "delivered" | "uncertain" | "conflict";

// The full identity of a shell_send operation: (runId, grantId, operationId). The operation_id is
// a client-chosen UUID — it is only unique WITHIN one grant's run, so every store operation
// (resolve, state update, eviction) and every in-flight ack correlation must key on all three.
// Keying by operationId alone lets a different grant's (or run's) record with the same UUID be
// updated, evicted, or ack-correlated in place of the intended one.
export function mcpOpKey(runId: string, grantId: string, operationId: string): string {
  return `${runId}\u001f${grantId}\u001f${operationId}`;
}

export interface McpOpRecord {
  runId: string;
  grantId: string;
  operationId: string;
  fingerprint: string; // SHA-256 hex of shellSendFingerprintInput (never the text itself)
  state: McpOpState;
  claimedAt: number; // unix ms
  // A non-content result for a terminal state: "delivered" or "delivery_uncertain". Never text.
  result: string | null;
}

// Bounded replay-protection store. On overflow the DO evicts expired (non-live grant) entries
// first, then conflict, then terminal uncertain, oldest-first — and NEVER a live grant's entry.
export const MAX_MCP_OPS = 256;

export type McpOpResolution =
  | { action: "claim" } // new ID, not yet claimed → claim it durably before dispatch
  | { action: "replay"; result: "delivered" | "delivery_uncertain" } // terminal, same fingerprint
  | { action: "in_flight" } // same ID still claiming/dispatched → coalesce, no second write
  | { action: "conflict" } // same ID, different fingerprint
  | { action: "capacity" }; // store full, cannot make room without evicting a live entry

// Resolve an operation_id against the store. Pure (no I/O): the caller persists the mutation.
export function resolveMcpOp(
  ops: readonly McpOpRecord[],
  runId: string,
  grantId: string,
  operationId: string,
  fingerprint: string,
): McpOpResolution {
  const existing = ops.find(
    (o) => o.runId === runId && o.grantId === grantId && o.operationId === operationId,
  );
  if (existing) {
    if (existing.fingerprint !== fingerprint) return { action: "conflict" };
    if (existing.state === "delivered") return { action: "replay", result: "delivered" };
    if (existing.state === "uncertain") return { action: "replay", result: "delivery_uncertain" };
    if (existing.state === "claiming" || existing.state === "dispatched") return { action: "in_flight" };
    if (existing.state === "conflict") return { action: "conflict" };
  }
  return { action: "claim" };
}

// Evict enough entries to make room for one new entry (the store would grow to ops.length + 1).
// Never evicts a live grant's entry; if it cannot make room without one, madeRoom is false and the
// caller must reject the new claim rather than drop an existing grant's replay protection.
export function evictMcpOps(
  ops: readonly McpOpRecord[],
  isLiveGrant: (grantId: string) => boolean,
  max: number,
): { evicted: McpOpRecord[]; madeRoom: boolean } {
  const need = ops.length + 1 - max;
  if (need <= 0) return { evicted: [], madeRoom: true };
  const rank = (o: McpOpRecord): number => {
    if (isLiveGrant(o.grantId)) return 100; // never evict a live grant's replay protection
    if (o.state === "conflict") return 1;
    if (o.state === "uncertain") return 2;
    return 3; // other non-live (expired) entries
  };
  const evictable = ops
    .filter((o) => rank(o) < 100)
    .sort((a, b) => (rank(a) !== rank(b) ? rank(a) - rank(b) : a.claimedAt - b.claimedAt));
  const evicted = evictable.slice(0, need);
  return { evicted, madeRoom: evicted.length >= need };
}
