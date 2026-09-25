import { describe, expect, it } from "vitest";
import { messageFor, readBatch } from "./agent-record";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/*
 * The payload is data from somebody else's machine. Everything here checks
 * the shape before using it: a renderer that draws whatever it is handed is a
 * renderer that draws whatever anybody can get the host to write.
 */
describe("reading what the host sent", () => {
  it("reads a conversation", () => {
    const batch = readBatch(
      bytes({
        harness: "claude-code",
        events: [
          { kind: "user", text: "npm test", at: 1000, seq: 1 },
          { kind: "assistant", text: "All passed.", at: 2000, seq: 2 },
          { kind: "tool", text: "Bash", at: 1500, seq: 3 },
        ],
      }),
    );
    expect(batch?.harness).toBe("claude-code");
    expect(batch?.events.map((event) => event.kind)).toEqual(["user", "assistant", "tool"]);
  });

  it("refuses anything that is not the shape it expects", () => {
    for (const payload of ["", "null", "[]", '"a string"', "{}", '{"events":"not a list"}', "{not json"]) {
      expect(readBatch(new TextEncoder().encode(payload))).toBeNull();
    }
  });

  it("drops an event it does not recognise rather than drawing it", () => {
    const batch = readBatch(
      bytes({
        harness: "x",
        events: [
          { kind: "thinking", text: "private" },
          { kind: "assistant", text: "public", at: 1, seq: 1 },
          { kind: "user" },
          null,
          "not an event",
        ],
      }),
    );
    expect(batch?.events).toHaveLength(1);
    expect(batch?.events[0].text).toBe("public");
  });

  it("does not let one message be a file", () => {
    const batch = readBatch(bytes({ events: [{ kind: "assistant", text: "x".repeat(200_000), at: 1, seq: 1 }] }));
    expect(batch?.events[0].text.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("does not let a menu be endless", () => {
    const options = Array.from({ length: 400 }, (_, n) => `option ${n}`);
    const batch = readBatch(
      bytes({ events: [{ kind: "choice", text: "pick", at: 1, seq: 1, choice: { question: "pick", header: "h", options } }] }),
    );
    expect(batch?.events[0].choice?.options.length).toBeLessThanOrEqual(12);
  });

  it("keeps a question only when it has a question and something to pick", () => {
    const missing = readBatch(
      bytes({ events: [{ kind: "choice", text: "", at: 1, seq: 1, choice: { question: "", options: ["a"] } }] }),
    );
    expect(missing).toBeNull();
    const empty = readBatch(
      bytes({ events: [{ kind: "choice", text: "", at: 1, seq: 1, choice: { question: "q", options: [] } }] }),
    );
    expect(empty).toBeNull();
  });
});

describe("what a recorded event becomes", () => {
  /* A record has roles, so nothing is inferred from how a line was drawn. */
  it("gives the person's message and the agent's their own kinds", () => {
    expect(messageFor({ kind: "user", text: "hello", at: 1, seq: 1 }).kind).toBe("sent");
    expect(messageFor({ kind: "assistant", text: "hi", at: 1, seq: 1 }).kind).toBe("received");
    expect(messageFor({ kind: "tool", text: "Bash", at: 1, seq: 1 }).kind).toBe("tool");
  });

  it("keeps an answer's own line breaks", () => {
    const message = messageFor({ kind: "assistant", text: "one\n\ntwo", at: 1, seq: 1 });
    expect(message.lines.map((line) => line.text)).toEqual(["one", "", "two"]);
  });

  it("carries a question's options through to the message", () => {
    const message = messageFor({
      kind: "choice",
      text: "Which colour?",
      at: 1,
      seq: 1,
      choice: { question: "Which colour?", header: "Colour", options: ["Red", "Blue"] },
    });
    expect(message.kind).toBe("received");
    expect(message.choice?.options).toEqual(["Red", "Blue"]);
    expect(message.lines[0].text).toBe("Which colour?");
  });
});
