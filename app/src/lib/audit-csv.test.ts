import { describe, expect, it } from "vitest";
import { auditCsv } from "./audit-csv";

describe("the audit log as CSV", () => {
  const sessions = [{ id: "s1", name: "deploy", command: "claude" }];

  it("writes a header and one row per entry, with the session's name", () => {
    const csv = auditCsv(
      [{ at: 0, sessionId: "s1", actorEmail: "ana@example.com", kind: "input", text: "npm test" }],
      sessions,
    );
    expect(csv.split("\r\n")).toEqual([
      '"timestamp","session","command","actor","kind","text","sealed_by"',
      '"1970-01-01T00:00:00.000Z","s1","deploy","ana@example.com","input","npm test",""',
    ]);
  });

  /* An entry sealed by somebody else afterwards does not speak for its author. */
  it("says who sealed an entry later, when somebody did", () => {
    const csv = auditCsv(
      [{ at: 0, sessionId: "s1", actorEmail: "a", kind: "input", text: "ls", sealedBy: "uid-admin" }],
      sessions,
    );
    expect(csv.split("\r\n")[1]).toContain('"uid-admin"');
  });

  it("survives commas, quotes and newlines in what was typed", () => {
    const csv = auditCsv(
      [{ at: 0, sessionId: "s1", actorEmail: "a", kind: "input", text: 'echo "a, b"\nls' }],
      sessions,
    );
    expect(csv).toContain('"echo ""a, b""\nls"');
  });

  it("stops a spreadsheet reading a typed line as a formula", () => {
    const csv = auditCsv(
      [{ at: 0, sessionId: "s1", actorEmail: "a", kind: "input", text: "=HYPERLINK(\"x\")" }],
      sessions,
    );
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("names a removed session by nothing rather than failing", () => {
    const csv = auditCsv([{ at: 0, sessionId: "gone", actorEmail: "a", kind: "deleted", text: "x" }], sessions);
    expect(csv.split("\r\n")[1]).toContain('"gone",""');
  });
});
