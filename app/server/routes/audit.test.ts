import { describe, expect, it } from "vitest";
import { auditCsv } from "./audit";
import type { AuditEvent, SessionRecord } from "../lib/store";

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "aud_1",
    orgId: "org_1",
    sessionId: "sess_1",
    at: Date.UTC(2026, 8, 6, 12, 0, 0),
    actorUid: "uid-1",
    actorEmail: "ana@example.com",
    kind: "input",
    text: "npm test",
    ...overrides,
  };
}

const sessions = [
  { id: "sess_1", command: "claude", name: "refactor run" } as SessionRecord,
];

describe("auditCsv", () => {
  it("writes a header and a row per event", async () => {
    const csv = auditCsv([event()], sessions);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe('"timestamp","session","command","actor","kind","text","sealed_by"');
    expect(row).toContain('"ana@example.com"');
    expect(row).toContain('"npm test"');
    expect(row).toContain('"refactor run"');
  });

  /*
   * An entry sealed after the fact says who sealed it. Their browser was given
   * the session, the author and the time by the service, so the export has to
   * show that it is not the first-hand record the other rows are.
   */
  it("names who sealed an entry that was not sealed first-hand", async () => {
    const [, firstHand] = auditCsv([event()], sessions).split("\r\n");
    expect(firstHand.endsWith(',""')).toBe(true);

    const [, resealed] = auditCsv([event({ sealedBy: "uid-2" })], sessions).split("\r\n");
    expect(resealed.endsWith(',"uid-2"')).toBe(true);
  });

  it("uses CRLF between rows, as a CSV reader expects", async () => {
    const csv = auditCsv([event(), event({ id: "aud_2" })], sessions);
    expect(csv.split("\r\n")).toHaveLength(3);
  });

  it("survives a command containing commas, quotes and newlines", async () => {
    /* Without quoting, an exported command would break the whole file. */
    const csv = auditCsv([event({ text: 'git commit -m "fix, again"\nsecond line' })], sessions);
    expect(csv).toContain('"git commit -m ""fix, again""\nsecond line"');
    /* The header plus one row, so the embedded newline did not split it. */
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it("neutralises a value a spreadsheet would treat as a formula", async () => {
    for (const dangerous of ["=1+1", "+SUM(A1)", "@import", "-2+3"]) {
      const csv = auditCsv([event({ text: dangerous })], sessions);
      expect(csv).toContain(`"'${dangerous}"`);
    }
  });

  it("writes an ISO timestamp", async () => {
    const csv = auditCsv([event()], sessions);
    expect(csv).toContain("2026-09-06T12:00:00.000Z");
  });

  it("falls back to the command when a session has no name", async () => {
    const csv = auditCsv([event()], [{ id: "sess_1", command: "htop" } as SessionRecord]);
    expect(csv).toContain('"htop"');
  });

  it("leaves the session column empty for a session it does not know", async () => {
    const csv = auditCsv([event({ sessionId: "gone" })], sessions);
    expect(csv).toContain('"gone",""');
  });

  it("writes just a header for an empty log", async () => {
    expect(auditCsv([], sessions).split("\r\n")).toHaveLength(1);
  });
});
