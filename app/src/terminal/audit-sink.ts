import { InputLog, type Entry } from "../lib/input-log";

export interface AuditEntry {
  session_id: string;
  kind: string;
  text: string;
  at: number;
}

/**
 * Injected rather than imported, so this module stays free of the API client
 * and its Firebase dependency, and can be tested without a browser.
 */
export type AuditSender = (entries: AuditEntry[]) => Promise<unknown>;

/**
 * Collects what a person entered in a session and sends it to the audit log.
 *
 * Batched, because a shell prompt produces an entry per line and a chatty
 * session would otherwise be one request per command. Failures are dropped
 * rather than retried forever: an audit gap is better than a terminal that
 * stalls because a log write is failing.
 */
export class AuditSink {
  private readonly log = new InputLog();
  private pending: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly send: AuditSender,
    private readonly flushMs = 1200,
  ) {}

  /** Feeds terminal input; entries are queued as lines are completed. */
  observe(data: string): void {
    const entries = this.log.push(data);
    if (entries.length === 0) return;
    this.pending.push(...entries);
    if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      await this.send(
        batch.map((entry) => ({
          session_id: this.sessionId,
          kind: entry.kind,
          text: entry.text,
          at: Date.now(),
        })),
      );
    } catch {
      /* An audit gap beats a terminal that stalls on a failing log write. */
    }
  }

  close(): void {
    void this.flush();
  }
}
