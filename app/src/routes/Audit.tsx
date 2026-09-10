import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DownloadSimple,
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
  downloadAuditCsv,
  fetchOrgAudit,
  fetchSessions,
  type AuditEvent,
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
import { usePageTitle } from "../lib/page-title";
import { displayName } from "../lib/people";
import { SearchSelect } from "../components/SearchSelect";
import type { SearchSelectOption } from "../lib/search-options";

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
  { label: "Handoffs", detail: "Assignment changes between teammates", value: "handoff" },
  { label: "Stopped", detail: "Processes stopped from the app", value: "stopped" },
  { label: "Removed", detail: "Sessions removed from the workspace", value: "deleted" },
];

/** A bar chart of when things happened. Inline SVG; no charting library. */
function ActivityChart({ events }: { events: AuditEvent[] }) {
  const buckets = useMemo(() => activity(events, 32), [events]);
  if (buckets.length === 0) return null;
  const peak = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const first = buckets[0].at;
  const last = buckets[buckets.length - 1].at;

  return (
    <figure className="chart">
      <figcaption>Activity</figcaption>
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
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  const [filters, setFilters] = useState<Filters>({
    ...EMPTY_FILTERS,
    session: params.get("session") ?? "",
  });

  const load = useCallback(async () => {
    try {
      const [list, trail] = await Promise.all([fetchSessions(), fetchOrgAudit()]);
      setSessions(list.sessions);
      setMembers(list.members ?? []);
      /*
       * Read as one trail rather than session by session. Asking each session
       * for its own log cannot return the entry for a session that has been
       * removed, and that entry is exactly what somebody comes here to find.
       */
      setEvents([...trail.events].sort((a, b) => b.at - a.at));
      setError("");
    } catch (caught) {
      setEvents([]);
      setError(caught instanceof Error ? caught.message : "Could not load the audit log.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (events ? applyFilters(events, filters) : []),
    [events, filters],
  );
  const summary = useMemo(() => summarise(shown), [shown]);
  const sessionOptions = useMemo<SearchSelectOption[]>(() => [
    { value: "", label: "All sessions", detail: "Activity across every session" },
    ...sessions.map((session) => ({
      value: session.id,
      label: session.name || session.command,
      detail: `${session.command}${session.host ? ` · ${session.host}` : ""}`,
      keywords: session.closedAt ? "finished offline" : "running live",
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

  function set(patch: Partial<Filters>) {
    setFilters((current) => {
      const next = { ...current, ...patch };
      if (patch.session !== undefined) {
        /* Keep the address bar honest, so a filtered view can be shared. */
        if (patch.session) setParams({ session: patch.session }, { replace: true });
        else setParams({}, { replace: true });
      }
      return next;
    });
  }

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await downloadAuditCsv(filters.session || undefined);
      const url = URL.createObjectURL(blob);
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

      {error && <div className="sessions-alert"><Alert tone="error">{error}</Alert></div>}

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
            setParams({}, { replace: true });
          }}>
            Clear
          </button>
        )}
      </div>

      {events === null ? (
        <div className="sessions-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
          <div className="stat-row">
            <Stat label="Entries" value={summary.total} />
            <Stat label="Commands and prompts" value={summary.inputs} />
            <Stat label="Interrupts" value={summary.interrupts} />
            <Stat label="People" value={summary.people} />
            <Stat label="Sessions" value={summary.sessions} />
          </div>

          {shown.length > 0 && (
            <div className="chart-row">
              <ActivityChart events={shown} />
              <RankChart
                caption="By user"
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
                caption="Most used"
                rows={topCommands(shown)}
                onPick={(word) => set({ query: word })}
                render={(word) => <code>{word}</code>}
              />
            </div>
          )}

          <h2 className="detail-heading">
            {isFiltered(filters) ? `${shown.length} matching` : "Everything"}
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
            <Trace events={shown} members={members} sessions={sessions} />
          )}
        </>
      )}
    </AppShell>
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
  events: AuditEvent[];
  members: Member[];
  sessions: SessionRecord[];
}) {
  const groups = traceGroups(events);

  let lastDay = "";
  return (
    <ol className="trace">
      {groups.map((group) => {
        const person = memberOf(members, group.actorUid);
        const day = new Date(group.events[0].at).toDateString();
        const newDay = day !== lastDay;
        lastDay = day;

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
              {group.events.map((event) => (
                <li key={event.id} data-kind={event.kind}>
                  <span className="trace-at">
                    {new Date(event.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <code>
                    {event.kind === "interrupt"
                      ? `^C${event.text ? ` while typing ${event.text}` : ""}`
                      : event.text || "—"}
                  </code>
                </li>
              ))}
            </ol>
          </li>
        );
      })}
    </ol>
  );
}
