import type { AuditEvent, Member, SessionRecord } from "./api";

/**
 * Shaping an audit log for reading.
 *
 * The log is a flat stream of everything anyone entered. What a reader wants
 * is usually narrower: one person, one session, one afternoon, or one word
 * they half remember. These are the pure parts of that, so the filtering and
 * the counting can be checked without a browser.
 */

export interface Filters {
  session: string;
  actor: string;
  kind: string;
  query: string;
  /** Milliseconds back from now, or 0 for everything. */
  since: number;
}

export const EMPTY_FILTERS: Filters = {
  session: "",
  actor: "",
  kind: "",
  query: "",
  since: 0,
};

export function applyFilters(
  events: AuditEvent[],
  filters: Filters,
  now = Date.now(),
): AuditEvent[] {
  const needle = filters.query.trim().toLowerCase();
  return events.filter((event) => {
    if (filters.session && event.sessionId !== filters.session) return false;
    if (filters.actor && event.actorUid !== filters.actor) return false;
    if (filters.kind && event.kind !== filters.kind) return false;
    if (filters.since && event.at < now - filters.since) return false;
    if (needle && !event.text.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function isFiltered(filters: Filters): boolean {
  return Boolean(
    filters.session || filters.actor || filters.kind || filters.query.trim() || filters.since,
  );
}

/* ---------------------------------------------------------------
   Aggregations
   --------------------------------------------------------------- */

export interface Bucket {
  at: number;
  count: number;
}

/**
 * Activity over time, in fixed buckets.
 *
 * Buckets are anchored to the span being shown rather than to each event, so
 * the bars line up with the axis and an empty stretch reads as quiet rather
 * than disappearing.
 */
export function activity(events: AuditEvent[], buckets = 24, now = Date.now()): Bucket[] {
  if (events.length === 0) return [];
  const times = events.map((event) => event.at);
  const first = Math.min(...times);
  const last = Math.max(Math.max(...times), Math.min(now, Math.max(...times)));
  const span = Math.max(last - first, 1);
  const width = Math.ceil(span / buckets);

  const counts = new Array<number>(buckets).fill(0);
  for (const time of times) {
    const index = Math.min(buckets - 1, Math.floor((time - first) / width));
    counts[index] += 1;
  }
  return counts.map((count, index) => ({ at: first + index * width, count }));
}

export interface Tally {
  key: string;
  count: number;
}

function tally(values: string[]): Tally[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function byActor(events: AuditEvent[]): Tally[] {
  return tally(events.map((event) => event.actorUid));
}

export function bySession(events: AuditEvent[]): Tally[] {
  return tally(events.map((event) => event.sessionId));
}


export interface Summary {
  total: number;
  opened: number;
  handoffs: number;
  people: number;
  sessions: number;
  firstAt?: number;
  lastAt?: number;
}

export function summarise(events: AuditEvent[]): Summary {
  const times = events.map((event) => event.at);
  return {
    total: events.length,
    opened: events.filter((event) => event.kind === "opened").length,
    handoffs: events.filter((event) => event.kind === "handoff").length,
    people: new Set(events.map((event) => event.actorUid)).size,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    firstAt: times.length ? Math.min(...times) : undefined,
    lastAt: times.length ? Math.max(...times) : undefined,
  };
}

/** A label for a session that never shows an id. */
export function sessionLabel(
  sessions: SessionRecord[],
  sessionId: string,
): string {
  const session = sessions.find((entry) => entry.id === sessionId);
  return session?.name || session?.command || "a removed session";
}

export function memberOf(members: Member[], uid: string): Member | undefined {
  return members.find((member) => member.uid === uid);
}
