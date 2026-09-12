import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DownloadSimple,
  LockKey,
  MagnifyingGlass,
  X,
  ArrowRight,
  Terminal as TerminalIcon,
} from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Avatar } from "../components/Avatar";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";
import {
  fetchOrgAudit,
  fetchSessions,
  type AuditEvent,
  type AuditPageRequest,
  type Member,
  type SessionRecord,
} from "../lib/api";
import {
  EMPTY_FILTERS,
  activity,
  applyFilters,
  byActor,
  isFiltered,
  memberOf,
  sessionLabel,
  summarise,
  topCommands,
  traceGroups,
  type Filters,
} from "../lib/audit-view";
import { auditCsv } from "../lib/audit-csv";
import { isAuditEnvelope } from "../lib/team-crypto";
import { usePageTitle } from "../lib/page-title";
import { displayName } from "../lib/people";
import { SearchSelect } from "../components/SearchSelect";
import { sessionStateLabel } from "../lib/session-liveness";
import type { SearchSelectOption } from "../lib/search-options";
import { useTeamKey } from "../vault/TeamKeyProvider";

const PAGE_SIZE = 40;
/* The service pages at most 100 at a time. */
const FETCH_SIZE = 100;
/*
 * How far back a text search reaches. What was typed is sealed to the team's
 * key, so the service cannot search it; the browser fetches entries, opens
 * them, and searches those. A limit keeps a search from pulling a whole
 * history down.
 */
const SEARCH_PAGES = 10;
/* An export takes everything, within reason. */
const EXPORT_PAGES = 100;

const RANGES = [
  { label: "All time", detail: "The complete retained audit trail", value: 0 },
  { label: "Last hour", detail: "Activity from the past 60 minutes", value: 60 * 60 * 1000 },
  { label: "Last 24 hours", detail: "Activity since this time yesterday", value: 24 * 60 * 60 * 1000 },
  { label: "Last 7 days", detail: "Activity from the past week", value: 7 * 24 * 60 * 60 * 1000 },
];

const KINDS = [
  { label: "Everything", detail: "Every recorded event type", value: "" },
  { label: "Commands and prompts", detail: "Submitted terminal input and agent prompts", value: "input" },
  { label: "Interrupts", detail: "Ctrl-C and interrupted input", value: "interrupt" },
  { label: "Opened", detail: "Sessions opened from the workspace", value: "opened" },
  { label: "Handoffs", detail: "Assignment changes between teammates", value: "handoff" },
  { label: "Stopped", detail: "Processes stopped from the app", value: "stopped" },
  { label: "Removed", detail: "Sessions removed from the workspace", value: "deleted" },
];

const EVENT_LABEL: Record<AuditEvent["kind"], string> = {
  input: "Submitted",
  interrupt: "Interrupted",
  opened: "Opened",
  handoff: "Assigned",
  stopped: "Stopped",
  deleted: "Removed",
};

/**
 * An entry as shown. `sealed` is whether it arrived encrypted at all: one
 * recorded before the log was encrypted, and not yet sealed, is still in the
 * clear on the service, and saying so is the point of showing it.
 */
type ShownEvent = AuditEvent & { readable: boolean; sealed: boolean };

/*
 * Everything the service can filter on. The text is not among them: the
 * service holds it sealed.
 */
function metadataRequest(filters: Filters): AuditPageRequest {
  return {
    session: filters.session || undefined,
    actor: filters.actor || undefined,
    kind: filters.kind || undefined,
    sinceAt: filters.since ? Date.now() - filters.since : undefined,
  };
}

/** A bar chart of when things happened. Inline SVG; no charting library. */
function ActivityChart({ events }: { events: AuditEvent[] }) {
  const buckets = useMemo(() => activity(events, 32), [events]);
  if (buckets.length === 0) return null;
  const peak = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const first = buckets[0].at;
  const last = buckets[buckets.length - 1].at;

  return (
    <figure className="chart">
      <figcaption>Activity on this page</figcaption>
      <div className="chart-bars" role="img" aria-label={`${events.length} entries over time`}>
        {buckets.map((bucket) => (
          <span
            key={bucket.at}
            className="chart-bar"
            /* A present-but-tiny bar still reads as "something happened". */
            style={{ height: `${bucket.count === 0 ? 2 : Math.max(8, (bucket.count / peak) * 100)}%` }}
            data-empty={bucket.count === 0}
            title={`${bucket.count} on ${new Date(bucket.at).toLocaleString()}`}
          />
        ))}
      </div>
      <div className="chart-axis">
        <span>{new Date(first).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        <span>{new Date(last).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </figure>
  );
}

/** A ranked list with proportional bars: who did the most, what ran the most. */
function RankChart({
  caption,
  rows,
  render,
  onPick,
}: {
  caption: string;
  rows: { key: string; count: number }[];
  render: (key: string) => React.ReactNode;
  onPick?: (key: string) => void;
}) {
  if (rows.length === 0) return null;
  const peak = rows[0].count;
  return (
    <figure className="chart">
      <figcaption>{caption}</figcaption>
      <ul className="rank">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              className="rank-row"
              onClick={() => onPick?.(row.key)}
              disabled={!onPick}
            >
              <span className="rank-label">{render(row.key)}</span>
              <span className="rank-track">
                <span className="rank-fill" style={{ width: `${(row.count / peak) * 100}%` }} />
              </span>
              <span className="rank-count">{row.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function Audit() {
  usePageTitle("Audit log");
  const team = useTeamKey();
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState<ShownEvent[] | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [reload, setReload] = useState(0);
  const [total, setTotal] = useState(0);
  /* For a text search: how many entries were searched, and whether there were more. */
  const [searched, setSearched] = useState<{ count: number; more: boolean } | null>(null);
  const [page, setPage] = useState(() => Math.max(1, Number(params.get("page")) || 1));

  const [filters, setFilters] = useState<Filters>({
    actor: params.get("actor") ?? "",
    kind: params.get("kind") ?? "",
    query: params.get("q") ?? "",
    since: Math.max(0, Number(params.get("since")) || 0),
    session: params.get("session") ?? "",
  });
  const [filtersOpen, setFiltersOpen] = useState(() =>
    ["actor", "kind", "session", "since"].some((name) => params.has(name)),
  );

  /* Opens what can be opened here; the rest is marked sealed, never shown as blank. */
  const { openAudit } = team;
  const readable = useCallback(
    async (list: AuditEvent[]): Promise<ShownEvent[]> =>
      Promise.all(
        list.map(async (event) => {
          if (!isAuditEnvelope(event.text)) return { ...event, readable: true, sealed: false };
          const opened = await openAudit(event);
          return { ...event, text: opened ?? "", readable: opened !== null, sealed: true };
        }),
      ),
    [openAudit],
  );

  const loadContext = useCallback(async () => {
    try {
      const list = await fetchSessions();
      setSessions(list.sessions);
      setMembers(list.members ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the audit log.");
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  useEffect(() => {
    let current = true;
    const needle = filters.query.trim();
    const timer = window.setTimeout(async () => {
      try {
        if (!needle) {
          const trail = await fetchOrgAudit({ ...metadataRequest(filters), page, limit: PAGE_SIZE });
          const shown = await readable(trail.events);
          if (!current) return;
          setEvents(shown);
          setTotal(trail.total);
          setSearched(null);
          setError("");
          if (trail.events.length === 0 && trail.total > 0 && page > 1) setPage(page - 1);
          return;
        }

        /*
         * A text search runs here: fetch the newest entries that match the
         * other filters, open them, and search what they say.
         */
        const fetched: AuditEvent[] = [];
        let more = false;
        for (let next = 1; next <= SEARCH_PAGES; next += 1) {
          const trail = await fetchOrgAudit({ ...metadataRequest(filters), page: next, limit: FETCH_SIZE });
          fetched.push(...trail.events);
          more = fetched.length < trail.total;
          if (!more || trail.events.length < FETCH_SIZE) break;
        }
        const matches = applyFilters(await readable(fetched), { ...EMPTY_FILTERS, query: needle }) as ShownEvent[];
        if (!current) return;
        setEvents(matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
        setTotal(matches.length);
        setSearched({ count: fetched.length, more });
        setError("");
      } catch (caught) {
        if (!current) return;
        setEvents([]);
        setTotal(0);
        setError(caught instanceof Error ? caught.message : "Could not load the audit log.");
      }
    }, needle ? 180 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    /* team.status: entries opened once the team key arrives. */
  }, [filters, page, reload, readable, team.status]);

  const shown = useMemo(() => events ?? [], [events]);
  const summary = useMemo(() => summarise(shown), [shown]);
  const secondaryFilterCount = [filters.session, filters.actor, filters.kind, filters.since]
    .filter(Boolean).length;
  const sessionOptions = useMemo<SearchSelectOption[]>(() => [
    { value: "", label: "All sessions", detail: "Activity across every session" },
    ...sessions.map((session) => ({
      value: session.id,
      label: session.name || session.command,
      detail: `${session.command}${session.host ? ` · ${session.host}` : ""}`,
      keywords: sessionStateLabel(session).toLowerCase(),
    })),
  ], [sessions]);
  const memberOptions = useMemo<SearchSelectOption[]>(() => [
    { value: "", label: "Everyone", detail: "Activity from every teammate" },
    ...members.map((member) => ({
      value: member.uid,
      label: displayName(member),
      detail: [member.email, member.role].filter(Boolean).join(" · "),
    })),
  ], [members]);

  function writeParams(next: Filters, nextPage: number) {
    const query = new URLSearchParams();
    if (next.session) query.set("session", next.session);
    if (next.actor) query.set("actor", next.actor);
    if (next.kind) query.set("kind", next.kind);
    if (next.query.trim()) query.set("q", next.query.trim());
    if (next.since) query.set("since", String(next.since));
    if (nextPage > 1) query.set("page", String(nextPage));
    setParams(query, { replace: true });
  }

  function set(patch: Partial<Filters>) {
    setFilters((current) => {
      const next = { ...current, ...patch };
      writeParams(next, 1);
      return next;
    });
    setPage(1);
  }

  function goToPage(nextPage: number) {
    setPage(nextPage);
    setEvents(null);
    writeParams(filters, nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /*
   * Built here, from entries opened here. The service cannot build it any
   * more: it holds what was typed sealed to the team's key.
   */
  async function handleExport() {
    setExporting(true);
    try {
      const fetched: AuditEvent[] = [];
      for (let next = 1; next <= EXPORT_PAGES; next += 1) {
        const trail = await fetchOrgAudit({ ...metadataRequest(filters), page: next, limit: FETCH_SIZE });
        fetched.push(...trail.events);
        if (fetched.length >= trail.total || trail.events.length < FETCH_SIZE) break;
      }
      let rows = await readable(fetched);
      if (filters.query.trim()) rows = applyFilters(rows, { ...EMPTY_FILTERS, query: filters.query }) as ShownEvent[];
      const csv = auditCsv(
        rows.map((event) => ({
          ...event,
          text: event.readable ? event.text : "[sealed: this browser does not hold the team's audit key]",
          sealedBy: event.sealedBy,
        })),
        sessions,
      );
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "shell-online-audit.csv";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <AppShell
      title="Audit log"
      aside={
        <Button type="button" onClick={handleExport} busy={exporting} busyLabel="Exporting">
          <DownloadSimple size={15} weight="bold" />
          Export CSV
        </Button>
      }
    >
      <p className="page-dek">
        Everything entered in this team's sessions: commands in a
        terminal, prompts to an agent, and who entered them.
      </p>

      {/*
        What protects this page, said where it is read. The team's audit key
        opens it; the service stores it sealed.
      */}
      <p className="audit-sealed-note" data-state={team.status}>
        <LockKey size={14} weight="bold" />
        <span>
          {team.status === "ready"
            ? "End-to-end encrypted for your team. shell.online stores what was typed sealed to your team's key and cannot read it; this page opens it in your browser, where search and export run too."
            : team.status === "waiting"
              ? "This browser does not have your team's audit key yet. A teammate's browser seals it to you the next time they open shell.online; until then, what was typed shows as sealed."
              : team.status === "error"
                ? team.error
                : "Opening your team's audit key."}
        </span>
      </p>

      {error && (
        <div className="sessions-alert audit-error">
          <Alert tone="error">
            <span>{error}</span>
            <button
              type="button"
              className="inline-retry"
              onClick={() => {
                setError("");
                setEvents(null);
                setReload((current) => current + 1);
                void loadContext();
              }}
            >
              Retry
            </button>
          </Alert>
        </div>
      )}

      <div className="filters">
        <div className="filter-search">
          <MagnifyingGlass size={15} />
          <input
            value={filters.query}
            onChange={(event) => set({ query: event.target.value })}
            placeholder="Search what was entered"
            aria-label="Search the audit log"
          />
          {filters.query && (
            <button type="button" onClick={() => set({ query: "" })} aria-label="Clear search">
              <X size={13} weight="bold" />
            </button>
          )}
        </div>

        <details
          className="audit-filter-more"
          open={filtersOpen}
          onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
        >
          <summary>
            Filters
            {secondaryFilterCount > 0 && <span>{secondaryFilterCount}</span>}
          </summary>
          <div className="audit-filter-panel">
            <SearchSelect
              label="Session"
              value={filters.session}
              options={sessionOptions}
              onChange={(session) => set({ session })}
              searchPlaceholder="Search sessions, commands, or machines"
            />

            <SearchSelect
              label="Person"
              value={filters.actor}
              options={memberOptions}
              onChange={(actor) => set({ actor })}
              searchPlaceholder="Search people, emails, or roles"
            />

            <SearchSelect
              label="Event type"
              value={filters.kind}
              options={KINDS}
              onChange={(kind) => set({ kind })}
              searchable={false}
              align="right"
            />

            <SearchSelect
              label="Time range"
              value={String(filters.since)}
              options={RANGES.map((range) => ({ ...range, value: String(range.value) }))}
              onChange={(since) => set({ since: Number(since) })}
              searchable={false}
              align="right"
            />

            {isFiltered(filters) && (
              <button type="button" className="filter-clear" onClick={() => {
                setFilters(EMPTY_FILTERS);
                setPage(1);
                setParams({}, { replace: true });
              }}>
                Clear all
              </button>
            )}
          </div>
        </details>
      </div>

      {searched && (
        <p className="audit-search-note">
          Searched the newest {searched.count} matching entr{searched.count === 1 ? "y" : "ies"} in your browser
          {searched.more ? ". Narrow the filters or the time range to search further back." : "."}
        </p>
      )}

      {events === null ? (
        <div className="sessions-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
          <div className="audit-reading-key" aria-label="How to read the audit log">
            <span><b>Person</b> who acted</span>
            <ArrowRight size={13} weight="bold" />
            <span><b>Action</b> they took</span>
            <ArrowRight size={13} weight="bold" />
            <span><b>Session</b> where it happened</span>
            <small>Newest activity is first. Times use your local timezone.</small>
          </div>

          {shown.length > 0 && (
            <details className="audit-overview">
              <summary>
                <span>Activity overview</span>
                <small>{total} matching entries</small>
              </summary>
              <div className="audit-page-summary">
              <div className="stat-row">
                <Stat label="Matching entries" value={total} />
                <Stat label="On this page" value={summary.total} />
                <Stat label="People on this page" value={summary.people} />
                <Stat label="Sessions on this page" value={summary.sessions} />
              </div>
              <div className="chart-row">
                <ActivityChart events={shown} />
                <RankChart
                  caption="People on this page"
                  rows={byActor(shown).slice(0, 6)}
                  onPick={(uid) => set({ actor: uid === filters.actor ? "" : uid })}
                  render={(uid) => {
                    const member = memberOf(members, uid);
                    return (
                      <span className="rank-person">
                        <Avatar person={member} size="xs" />
                        {displayName(member)}
                      </span>
                    );
                  }}
                />
                <RankChart
                  caption="Commands on this page"
                  rows={topCommands(shown)}
                  onPick={(word) => set({ query: word })}
                  render={(word) => <code>{word}</code>}
                />
              </div>
              </div>
            </details>
          )}

          <h2 className="detail-heading">
            {total > 0
              ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`
              : isFiltered(filters) ? "No matches" : "Everything"}
          </h2>

          {shown.length === 0 ? (
            <div className="sessions-empty">
              <p>{isFiltered(filters) ? "Nothing matches those filters." : "Nothing recorded yet."}</p>
              <ol>
                <li>Open a session as a tab.</li>
                <li>Type a command, or a prompt for an agent.</li>
                <li>It appears here once submitted.</li>
              </ol>
            </div>
          ) : (
            <>
              <Trace events={shown} members={members} sessions={sessions} />
              <Pagination
                page={page}
                pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))}
                onPage={goToPage}
              />
            </>
          )}
        </>
      )}
    </AppShell>
  );
}

function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage(page: number): void;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav className="pagination" aria-label="Audit pages">
      <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span>Page {page} of {pageCount}</span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>
        Next
      </button>
    </nav>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/**
 * The log itself, grouped by day and by run of one person in one session.
 *
 * A flat list of timestamps is hard to follow; grouping consecutive entries
 * under one heading makes a trace read as what somebody did, in order.
 */
function Trace({
  events,
  members,
  sessions,
}: {
  events: ShownEvent[];
  members: Member[];
  sessions: SessionRecord[];
}) {
  const groups = traceGroups(events);
  const withDay = groups.map((group, index) => {
    const day = new Date(group.events[0].at).toDateString();
    const previous = groups[index - 1];
    const previousDay = previous ? new Date(previous.events[0].at).toDateString() : "";
    return { group, newDay: day !== previousDay };
  });
  return (
    <ol className="trace">
      {withDay.map(({ group, newDay }) => {
        const person = memberOf(members, group.actorUid);

        return (
          <li key={group.key} className="trace-group">
            {newDay && (
              <p className="trace-day">
                {new Date(group.events[0].at).toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </p>
            )}
            <div className="trace-head">
              <Avatar person={person} size="sm" />
              <span className="trace-who">{displayName(person)}</span>
              <ArrowRight size={12} weight="bold" className="trace-arrow" />
              <Link className="trace-session" to={`/sessions/${group.sessionId}`}>
                <TerminalIcon size={13} />
                {sessionLabel(sessions, group.sessionId)}
              </Link>
              <time className="trace-time">
                {new Date(group.events[0].at).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <ol className="trace-lines">
              {(group.events as ShownEvent[]).map((event) => (
                <li key={event.id} data-kind={event.kind}>
                  <span className="trace-at">
                    {new Date(event.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="trace-kind">{EVENT_LABEL[event.kind]}</span>
                  {event.readable ? (
                    <code>
                      {event.kind === "interrupt"
                        ? `^C${event.text ? ` while typing ${event.text}` : ""}`
                        : event.text || "—"}
                    </code>
                  ) : (
                    <span className="trace-sealed">
                      <LockKey size={12} weight="bold" /> Sealed. This browser does not hold the team&apos;s key yet.
                    </span>
                  )}
                  {/*
                    Where an entry came from, when that is not simply "the
                    person who typed it". One sealed afterwards was bound to
                    this person and time by whoever sealed it, not by them, and
                    one still in the clear is readable by the service.
                  */}
                  {event.sealedBy && (
                    <span className="trace-provenance">
                      sealed later by {displayName(memberOf(members, event.sealedBy))}
                    </span>
                  )}
                  {!event.sealed && (event.kind === "input" || event.kind === "interrupt") && (
                    <span className="trace-provenance" data-clear="true">
                      recorded before encryption, still in the clear
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </li>
        );
      })}
    </ol>
  );
}
