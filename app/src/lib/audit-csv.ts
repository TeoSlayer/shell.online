/**
 * The audit log as CSV, built in the browser.
 *
 * The service used to build this, and it can no longer: what people typed
 * reaches it sealed to the team's key. So the browser, which can open it,
 * writes the file instead.
 */

export interface CsvEvent {
  at: number;
  sessionId: string;
  actorEmail: string;
  kind: string;
  text: string;
  /** Who sealed the entry later, if anyone; empty for a first-hand entry. */
  sealedBy?: string;
}

export interface CsvSession {
  id: string;
  name?: string;
  command: string;
}

export function auditCsv(events: CsvEvent[], sessions: CsvSession[]): string {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const header = ["timestamp", "session", "command", "actor", "kind", "text", "sealed_by"];
  const rows = events.map((event) => {
    const session = byId.get(event.sessionId);
    return [
      new Date(event.at).toISOString(),
      event.sessionId,
      session?.name || session?.command || "",
      event.actorEmail,
      event.kind,
      event.text,
      event.sealedBy ?? "",
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/*
 * RFC 4180 quoting. A recorded command can contain commas, quotes and
 * newlines, and a leading =, +, - or @ is prefixed because spreadsheets read
 * those as formulas.
 */
function csvCell(value: string): string {
  const guarded = /^[=+@\t\r-]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
