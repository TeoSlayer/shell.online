import { describe, expect, it } from "vitest";
import {
  StreamingSanitizer,
  StreamingUtf8Decoder,
  capUtf8,
  decodeUtf8,
  sanitizeText,
} from "../shared/mcp-sanitize";

describe("decodeUtf8", () => {
  it("decodes valid UTF-8", () => {
    expect(decodeUtf8(new TextEncoder().encode("héllo → 世界"))).toBe("héllo → 世界");
  });

  it("replaces malformed sequences with U+FFFD and never throws", () => {
    // 0xff 0xfe are not valid UTF-8 lead/continuation bytes.
    expect(decodeUtf8(new Uint8Array([0x61, 0xff, 0xfe, 0x62]))).toBe("a\u{fffd}\u{fffd}b");
  });

  it("decodes a truncated multi-byte sequence to U+FFFD", () => {
    // "é" is 0xc3 0xa9; drop the continuation byte.
    expect(decodeUtf8(new Uint8Array([0x61, 0xc3, 0x62]))).toBe("a\u{fffd}b");
  });

  it("handles empty input", () => {
    expect(decodeUtf8(new Uint8Array(0))).toBe("");
  });
});

describe("sanitizeText", () => {
  it("preserves plain text and \\r\\n\\t", () => {
    expect(sanitizeText("line one\r\nline two\ttabbed")).toBe("line one\r\nline two\ttabbed");
  });

  it("strips SGR color sequences (CSI)", () => {
    expect(sanitizeText("\x1b[1;32mcalin\x1b[0m:~/repo$")).toBe("calin:~/repo$");
  });

  it("strips cursor/screen-control CSI sequences", () => {
    expect(sanitizeText("\x1b[2J\x1b[Hhello\x1b[10;5Hworld")).toBe("helloworld");
  });

  it("strips OSC title (BEL-terminated)", () => {
    expect(sanitizeText("\x1b]0;my title\x07output")).toBe("output");
  });

  it("strips OSC hyperlink (BEL-terminated)", () => {
    expect(sanitizeText("see \x1b]8;;https://shell.online\x07link\x1b]8;;\x07 here")).toBe("see link here");
  });

  it("strips OSC clipboard (OSC 52)", () => {
    expect(sanitizeText("\x1b]52;c;SGVsbG8=\x07copied")).toBe("copied");
  });

  it("strips OSC terminated by ST (ESC \\)", () => {
    expect(sanitizeText("\x1b]8;;https://x.y\x1b\\text")).toBe("text");
  });

  it("strips DCS sequences (ST-terminated)", () => {
    expect(sanitizeText("\x1bP+q1234\x1b\\after")).toBe("after");
  });

  it("strips APC and SOS sequences", () => {
    expect(sanitizeText("\x1b_GitHub;cmd\x1b\\\x1b^sos\x1b\\ok")).toBe("ok");
  });

  it("strips charset designations (three-byte)", () => {
    expect(sanitizeText("\x1b(Btext")).toBe("text");
  });

  it("strips two-byte escapes (DECSC, RI, RIS)", () => {
    expect(sanitizeText("\x1b7saved\x1b8\x1bMrev\x1bCreset")).toBe("savedrevreset");
  });

  it("drops lone control characters but keeps \\r\\n\\t", () => {
    // \x00, \x01, \x7f dropped; \x1b+d is a two-byte escape (dropped); \r\n\t kept.
    expect(sanitizeText("a\x00b\x01c\x1bd\x7fe\r\nf\tg")).toBe("abce\r\nf\tg");
  });

  it("consumes a two-byte escape, a trailing bare ESC, and an incomplete trailing CSI", () => {
    expect(sanitizeText("a\x1bb")).toBe("a"); // ESC + printable = two-byte escape (both consumed)
    expect(sanitizeText("a\x1b")).toBe("a"); // trailing bare ESC
    expect(sanitizeText("a\x1b[1;3")).toBe("a"); // incomplete trailing CSI
  });

  it("preserves surrogate pairs (emoji)", () => {
    expect(sanitizeText("\x1b[31m\ud83d\ude80\x1b[0m")).toBe("\ud83d\ude80");
  });

  it("returns empty for all-control input", () => {
    expect(sanitizeText("\x1b[2J\x1b[H\x00\x7f")).toBe("");
  });

  it("handles empty input", () => {
    expect(sanitizeText("")).toBe("");
  });

  it("does not leak a bare ESC from a mid-string OSC without terminator", () => {
    // An unterminated OSC at end of input is consumed to the end (no bare ESC, no raw payload).
    expect(sanitizeText("before\x1b]8;;https://x.y")).toBe("before");
  });
});

describe("StreamingSanitizer (state across frames)", () => {
  it("consumes an OSC split across two feeds (no payload leak)", () => {
    const s = new StreamingSanitizer();
    // OSC 52 (clipboard) introducer in the first feed, payload + BEL in the second.
    expect(s.feed("a\x1b]52;c;")).toBe("a");
    expect(s.feed("SGVsbG8=\x07copied")).toBe("copied");
  });

  it("consumes a CSI split across two feeds", () => {
    const s = new StreamingSanitizer();
    expect(s.feed("\x1b[1;")).toBe("");
    expect(s.feed("32mcolored\x1b[0m")).toBe("colored");
  });

  it("consumes a DCS split across feeds (ST in the second)", () => {
    const s = new StreamingSanitizer();
    expect(s.feed("\x1bP+q12")).toBe("");
    expect(s.feed("34\x1b\\after")).toBe("after");
  });

  it("strips C1 control characters", () => {
    const s = new StreamingSanitizer();
    // 0x9b is the C1 form of ESC [; 0x80-0x9f are C1 controls (dropped).
    expect(s.feed("a\u009bb\u0080c")).toBe("abc");
  });

  it("matches the stateless sanitizeText on a complete buffer", () => {
    const input = "\x1b[1;32mcalin\x1b]0;title\x07\x1b[0m:~/repo$";
    const s = new StreamingSanitizer();
    expect(s.feed(input)).toBe(sanitizeText(input));
  });
});

describe("StreamingUtf8Decoder (multi-byte across frames)", () => {
  it("decodes a € split across two frames without U+FFFD", () => {
    const d = new StreamingUtf8Decoder();
    const euro = new TextEncoder().encode("a€b"); // 61 E2 82 AC 62
    // Split after the first byte of the € (E2).
    expect(d.feed(euro.subarray(0, 2))).toBe("a");
    expect(d.feed(euro.subarray(2))).toBe("€b");
  });

  it("decodes a 4-byte emoji split across three frames", () => {
    const d = new StreamingUtf8Decoder();
    const rocket = new TextEncoder().encode("\ud83d\ude80"); // F0 9F 9A 80
    expect(d.feed(rocket.subarray(0, 1))).toBe("");
    expect(d.feed(rocket.subarray(1, 3))).toBe("");
    expect(d.feed(rocket.subarray(3))).toBe("\ud83d\ude80");
  });

  it("still replaces a genuinely malformed byte with U+FFFD", () => {
    const d = new StreamingUtf8Decoder();
    expect(d.feed(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a\u{fffd}b");
  });

  it("F3: keeps memory bounded under a stream of malformed UTF-8 (lone continuation bytes)", () => {
    // A long run of lone continuation bytes (0x80) with no lead byte. A correct decoder must not
    // carry an unbounded pending buffer: each byte is malformed (U+FFFD) and is flushed, so the
    // decoded output grows with the input rather than the input accumulating in pending state.
    const d = new StreamingUtf8Decoder();
    let out = "";
    for (let i = 0; i < 1000; i += 1) out += d.feed(new Uint8Array([0x80]));
    expect(out.length).toBe(1000);
    expect(out).toBe("\u{fffd}".repeat(1000));
  });
});

describe("capUtf8 (byte budget, most recent)", () => {
  it("keeps the most recent bytes within the budget", () => {
    const { text, truncated } = capUtf8("abcdefghij", 5);
    expect(text).toBe("fghij");
    expect(truncated).toBe(true);
  });

  it("does not split a multi-byte character at the cut", () => {
    // 日本語テスト = 18 bytes; budget 6 = most recent 2 chars (スト).
    const { text, truncated } = capUtf8("日本語テスト", 6);
    expect(text).toBe("スト");
    expect(truncated).toBe(true);
  });

  it("backs off a continuation byte to a character boundary", () => {
    // "a€b" = 61 E2 82 AC 62 (5 bytes); budget 3 cuts inside the € -> back off to the last whole char.
    const { text, truncated } = capUtf8("a€b", 3);
    expect(text).toBe("b");
    expect(truncated).toBe(true);
  });

  it("returns the input unchanged when within budget", () => {
    const { text, truncated } = capUtf8("abc", 10);
    expect(text).toBe("abc");
    expect(truncated).toBe(false);
  });
});
