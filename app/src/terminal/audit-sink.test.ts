import { describe, expect, it, vi } from "vitest";
import { AuditSink } from "./audit-sink";

type Sent = { session_id: string; kind: string; text: string; at: number }[];

function sink(flushMs = 5) {
  const batches: Sent[] = [];
  const send = vi.fn(async (entries: Sent) => {
    batches.push(entries);
    return { written: entries.length };
  });
  return { sink: new AuditSink("sess_1", send, flushMs), batches, send };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AuditSink", () => {
  it("records a completed line, not the keystrokes", async () => {
    const { sink: audit, batches } = sink();
    for (const character of "npm test\r") audit.observe(character);
    await settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0]).toMatchObject({
      session_id: "sess_1",
      kind: "input",
      text: "npm test",
    });
  });

  it("sends nothing while a line is still being typed", async () => {
    const { sink: audit, send } = sink();
    audit.observe("git comm");
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("batches several lines into one request", async () => {
    const { sink: audit, batches } = sink(20);
    audit.observe("one\r");
    audit.observe("two\r");
    audit.observe("three\r");
    await settle(60);

    expect(batches).toHaveLength(1);
    expect(batches[0].map((entry) => entry.text)).toEqual(["one", "two", "three"]);
  });

  it("records an interrupt", async () => {
    const { sink: audit, batches } = sink();
    audit.observe("sleep 100\x03");
    await settle();
    expect(batches[0][0]).toMatchObject({ kind: "interrupt", text: "sleep 100" });
  });

  it("flushes what is pending when the pane closes", async () => {
    const { sink: audit, batches } = sink(10_000);
    audit.observe("ls\r");
    audit.close();
    await settle();
    expect(batches[0][0].text).toBe("ls");
  });

  it("keeps the terminal working when the log write fails", async () => {
    /* An audit gap is better than a terminal that stalls on a failing write. */
    const failing = vi.fn(async () => {
      throw new Error("service down");
    });
    const audit = new AuditSink("sess_1", failing as never, 5);
    audit.observe("ls\r");
    await settle();
    expect(failing).toHaveBeenCalled();

    /* And it carries on afterwards. */
    audit.observe("pwd\r");
    await settle();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("does not send an empty batch", async () => {
    const { sink: audit, send } = sink();
    await audit.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
