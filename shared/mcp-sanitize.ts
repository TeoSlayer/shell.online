// Runtime-neutral terminal-output sanitizer for the MCP observe surface. Terminal output is
// always untrusted content; before any screen or output text reaches an MCP client it is reduced
// to plain text here. This strips ANSI/CSI/OSC/DCS/SOS/APC/PM sequences (including clipboard and
// hyperlink OSCs), C0 and C1 control characters, and charset designations, keeping printable text
// plus \r, \n, and \t. It is the single redaction point for terminal content on the observe surface.
//
// The streaming forms (StreamingSanitizer, StreamingUtf8Decoder) carry parser state across frame
// boundaries and truncation boundaries, so an escape sequence or a multi-byte UTF-8 character split
// across frames is handled correctly rather than leaking a bare ESC or a U+FFFD.

export type SanitizeState =
  | "ground"
  | "escape"
  | "charset"
  | "csi"
  | "osc"
  | "oscEscape"
  | "dcs"
  | "dcsEscape";

// Decode UTF-8 bytes to a string, replacing malformed sequences with U+FFFD (never throws).
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Strip escape sequences and control characters from a complete string, keeping printable text
// plus \r, \n, and \t. Surrogate pairs (e.g. emoji) are preserved. This is a convenience wrapper
// over StreamingSanitizer for callers that have the whole buffer at once.
export function sanitizeText(input: string): string {
  return new StreamingSanitizer().feed(input);
}

// Cap a string to a UTF-8 byte budget, keeping the MOST RECENT bytes (the tail), never splitting
// a multi-byte character. Reports whether anything was dropped.
export function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let start = bytes.byteLength - maxBytes;
  // Advance over continuation bytes (0b10xxxxxx) so the cut lands on a character boundary.
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start)), truncated: true };
}

// Streaming UTF-8 decoder: carries an incomplete trailing multi-byte sequence across feed() calls
// so a character split across two frames decodes correctly (no U+FFFD for a valid split char).
export class StreamingUtf8Decoder {
  private pending = new Uint8Array(0);

  feed(bytes: Uint8Array): string {
    const combined = this.pending.byteLength === 0 ? bytes : concatBytes(this.pending, bytes);
    const completeEnd = completeUtf8Boundary(combined);
    const complete = combined.subarray(0, completeEnd);
    this.pending = combined.slice(completeEnd);
    return complete.byteLength === 0 ? "" : decodeUtf8(complete);
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }
}

// The index just past the last complete UTF-8 character in `bytes`. Bytes at/after the return
// value form an incomplete trailing sequence (kept pending by the caller). A valid character is at
// most 4 bytes, so the incomplete trailing sequence is at most 4 bytes: the search for its lead
// byte never walks past (len - 4). A longer trailing run of continuation bytes is malformed and
// belongs to the decodable (complete) prefix, so a hostile stream of lone continuation bytes can't
// grow the pending buffer without bound.
function completeUtf8Boundary(bytes: Uint8Array): number {
  const len = bytes.byteLength;
  let i = len;
  const floor = Math.max(0, len - 4);
  while (i > floor && (bytes[i - 1] & 0xc0) === 0x80) i -= 1;
  if (i === 0) return 0;
  const lead = bytes[i - 1];
  const expected =
    (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
  const available = len - (i - 1);
  return available >= expected ? len : i - 1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// Stateful escape-sequence / control-character stripper. Feed terminal output incrementally; the
// parser state (e.g. "inside an OSC") is retained across feed() calls, so a sequence split across
// frames is consumed whole. A trailing incomplete sequence is held (not emitted) until it can be
// resolved by a later feed or flushed.
export class StreamingSanitizer {
  private state: SanitizeState;

  // Accepts an initial parser state so a caller can resume sanitization from a known boundary
  // (e.g. the start of a bounded tail that begins mid-sequence) rather than always from ground.
  constructor(initial: SanitizeState = "ground") {
    this.state = initial;
  }

  // The current parser state, so a caller can carry it across a boundary (e.g. a tail trim).
  get currentState(): SanitizeState {
    return this.state;
  }

  // Process a chunk of terminal text and return the sanitized plain text emitted for this chunk.
  feed(input: string): string {
    let out = "";
    let i = 0;
    const n = input.length;
    while (i < n) {
      const ch = input[i];
      const code = input.charCodeAt(i);
      switch (this.state) {
        case "ground": {
          if (ch === "\x1b") {
            this.state = "escape";
            i += 1;
            continue;
          }
          if (isControl(code) && ch !== "\r" && ch !== "\n" && ch !== "\t") {
            i += 1;
            continue;
          }
          out += ch;
          i += 1;
          continue;
        }
        case "escape": {
          if (ch === "[") {
            this.state = "csi";
            i += 1;
            continue;
          }
          if (ch === "]") {
            this.state = "osc";
            i += 1;
            continue;
          }
          if (ch === "P" || ch === "^" || ch === "_" || ch === "X") {
            this.state = "dcs";
            i += 1;
            continue;
          }
          if (ch === "(" || ch === ")" || ch === "*" || ch === "+") {
            this.state = "charset";
            i += 1;
            continue;
          }
          // Two-byte escape (IND, RI, RIS, DECSC/DECRC, keypad modes, ...) or a lone/malformed ESC:
          // the ESC was already consumed entering this state; drop the follower too, then ground.
          this.state = "ground";
          i += 1;
          continue;
        }
        case "charset": {
          // ESC ( X — consume the designation byte, back to ground.
          this.state = "ground";
          i += 1;
          continue;
        }
        case "csi": {
          if (code >= 0x40 && code <= 0x7e) {
            this.state = "ground";
          }
          i += 1;
          continue;
        }
        case "osc": {
          if (ch === "\x07") {
            this.state = "ground";
            i += 1;
            continue;
          }
          if (ch === "\x1b") {
            this.state = "oscEscape";
            i += 1;
            continue;
          }
          i += 1;
          continue;
        }
        case "oscEscape": {
          // ST (ESC \) terminates the OSC.
          if (ch === "\\") {
            this.state = "ground";
            i += 1;
            continue;
          }
          // Not ST: the ESC was part of the OSC payload; keep consuming the OSC.
          this.state = "osc";
          i += 1;
          continue;
        }
        case "dcs": {
          if (ch === "\x1b") {
            this.state = "dcsEscape";
            i += 1;
            continue;
          }
          i += 1;
          continue;
        }
        case "dcsEscape": {
          if (ch === "\\") {
            this.state = "ground";
            i += 1;
            continue;
          }
          this.state = "dcs";
          i += 1;
          continue;
        }
      }
    }
    return out;
  }

  // Drop any held (incomplete trailing) sequence. Call on reset/reseed so a dangling sequence does
  // not bleed into the next epoch.
  reset(): void {
    this.state = "ground";
  }
}

// C0 (0x00-0x1f), DEL (0x7f), and C1 (0x80-0x9f) controls.
function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}
