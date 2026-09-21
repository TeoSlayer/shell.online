export type SessionPulse = {
  activity: "unobserved" | "output" | "quiet";
  lastOutputAt: number | null;
  bytesSinceViewed: number;
  hint: null | { kind: "attention" | "result"; label: string };
};

const QUIET_MS = 15_000;
const HINT_MS = 120_000;
const MAX_UNREAD = 1024 * 1024;
const MAX_LINE = 1024;
type EscapeState = "text" | "escape" | "csi" | "string" | "stringEscape";

/** Local observations only: no transcript, persistence, requests or process-state inference. */
export class SessionPulseTracker {
  private decoder = new TextDecoder();
  private escape: EscapeState = "text";
  private line = "";
  private overflow = false;
  private lastOutputAt: number | null = null;
  private bytesSinceViewed = 0;
  private hint: SessionPulse["hint"] = null;
  private hintAt = 0;
  private matchedLine = "";

  feed(data: Uint8Array, now: number, opts: { snapshot?: boolean; active?: boolean } = {}): void {
    // A snapshot is a complete replacement screen, independent of prior stream
    // fragments. Its content can replace hints but is not fresh output.
    if (opts.snapshot) this.resetParser();
    if (!data.byteLength) return;
    if (!opts.snapshot) {
      this.lastOutputAt = now;
      this.bytesSinceViewed = opts.active ? 0 : Math.min(MAX_UNREAD, this.bytesSinceViewed + data.byteLength);
    }
    // Decode in bounded pieces, including split UTF-8 code points. Escape strings
    // are discarded as a stream, even when an attacker never terminates one.
    for (let offset = 0; offset < data.length; offset += 4096) {
      const text = this.decoder.decode(data.subarray(offset, offset + 4096), { stream: true });
      for (const char of text) this.consume(char, now);
    }
    this.detect(now); // Interactive prompts need not end with a newline.
  }

  viewed(): void {
    this.bytesSinceViewed = 0;
  }

  reset(): void {
    this.resetParser();
    this.lastOutputAt = null;
    this.bytesSinceViewed = 0;
  }

  private resetParser(): void {
    this.decoder = new TextDecoder();
    this.escape = "text";
    this.clearLine();
    this.hint = null;
    this.hintAt = 0;
  }

  value(now: number): SessionPulse {
    if (this.hint && now - this.hintAt >= HINT_MS) this.hint = null;
    return {
      activity: this.lastOutputAt === null ? "unobserved" : now - this.lastOutputAt >= QUIET_MS ? "quiet" : "output",
      lastOutputAt: this.lastOutputAt,
      bytesSinceViewed: this.bytesSinceViewed,
      hint: this.hint ? { ...this.hint } : null,
    };
  }

  private clearLine(): void {
    this.line = "";
    this.overflow = false;
    this.matchedLine = "";
  }

  private consume(char: string, now: number): void {
    if (this.escape === "string" || this.escape === "stringEscape") {
      if (char === "\x07" || char === "\x9c" || (this.escape === "stringEscape" && char === "\\")) {
        this.escape = "text";
      } else {
        this.escape = char === "\x1b" ? "stringEscape" : "string";
      }
      return;
    }
    if (this.escape === "csi") {
      if (char >= "@" && char <= "~") {
        this.escape = "text";
        if (char !== "m") this.clearLine();
      } else if (char === "\x1b") {
        this.escape = "escape";
      }
      return;
    }
    if (this.escape === "escape") {
      if (char === "[") this.escape = "csi";
      else if ("]PX^_".includes(char)) this.escape = "string";
      else if (char >= "0" && char <= "~") {
        this.escape = "text";
        this.clearLine();
      }
      return;
    }
    if (char === "\x1b") this.escape = "escape";
    else if (char === "\x9b") this.escape = "csi";
    else if ("\x90\x98\x9d\x9e\x9f".includes(char)) this.escape = "string";
    else if (char === "\n" || char === "\r") {
      this.detect(now);
      this.clearLine();
    } else if (char === "\b") {
      this.line = this.line.slice(0, -1);
    } else if (char === "\t" || (char >= " " && !(char >= "\x7f" && char <= "\x9f"))) {
      if (this.overflow) return;
      if (this.line.length >= MAX_LINE) {
        this.line = "";
        this.overflow = true;
      } else this.line += char;
    }
  }

  private detect(now: number): void {
    if (this.overflow || this.escape !== "text") return;
    const line = this.line.trim();
    if (!line || line === this.matchedLine) return;
    let hint: SessionPulse["hint"] = null;
    if (/^(?:error:\s*)?(?:context (?:window |length )?(?:limit (?:reached|exceeded)|exceeded|too (?:large|long))|maximum context length (?:exceeded|is \d+)|compaction failed|(?:auto[- ]?)?compact(?:ion)? (?:failed|failure))(?:[.!:]|$)/i.test(line)
      || /^(?:[┃│]\s*)?Session too large to compact - context exceeds model limit even after stripping media$/.test(line)) {
      hint = { kind: "attention", label: "Context limit reported" };
    } else if (/^(?:(?:approval|permission) required[.!:]?|(?:approve|allow) (?:this )?(?:command|execution|operation)\?\s*\[(?:y\/n|yes\/no)\]|(?:proceed|continue)\?\s*\[(?:y\/n|yes\/no)\])$/i.test(line)) {
      hint = { kind: "attention", label: "Input may be needed" };
    } else if (/^(?:Tests|Test Files|Test Suites):?\s+\d+\s+(?:passed|failed)(?:\s*[,|]\s*\d+\s+(?:passed|failed|skipped|pending|todo|total))*(?:\s+\(\d+\))?$/i.test(line)
      || /^=+\s+\d+ (?:passed|failed)(?:, \d+ (?:passed|failed|skipped|deselected|warnings?))*(?: in \d+(?:\.\d+)?s)?\s+=+$/.test(line)
      || /^test result: (?:ok|FAILED)\. \d+ passed; \d+ failed; \d+ ignored;.*$/.test(line)) {
      hint = { kind: "result", label: "Test result reported" };
    }
    if (hint) {
      this.hint = hint;
      this.hintAt = now;
      this.matchedLine = line;
    }
  }
}
