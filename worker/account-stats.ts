import type { StatsAccountPeriod, StatsAccounts, StatsAccountStats, StatsRange } from "../shared/stats";

/*
 * The accounts app keeps the only exact count of people: accounts. It answers
 * aggregates -- how many, how many new, how many active, how many back each
 * week -- to a bearer token, and nothing per person. Our own accounts are
 * already out of every figure by the time it answers; see the app's
 * internal-accounts.ts for why that is done there and not here.
 *
 * Left out when the dashboard is not linked to an app, and reported as
 * unavailable rather than left out when it is linked and does not answer, so
 * a broken link shows on the dashboard instead of looking like a quiet week.
 */
export async function fetchAccountStats(
  base: string | undefined,
  token: string | undefined,
  range: StatsRange,
  fetchImplementation: typeof fetch = fetch,
): Promise<StatsAccounts> {
  const origin = base?.trim();
  const secret = token?.trim();
  if (!origin || !secret) return null;
  try {
    const response = await fetchImplementation(
      `${origin.replace(/\/+$/, "")}/api/stats/accounts?range=${range}`,
      {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok) return { error: `accounts app answered ${response.status}` };
    const body = await response.json();
    if (!isAccountStats(body)) return { error: "accounts app answered in an unexpected shape" };
    return completeAccountStats(body);
  } catch {
    return { error: "accounts app did not answer" };
  }
}

/*
 * The counts the dashboard cannot do without. Everything else it asks for is
 * filled in below when an older app has not got it yet, so a Worker deployed
 * ahead of the app shows the figures it can rather than an error.
 */
function isAccountStats(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.total === "number" &&
    typeof candidate.newInRange === "number" &&
    typeof candidate.activeInRange === "number" &&
    Array.isArray(candidate.newByDay) &&
    Array.isArray(candidate.cohorts);
}

export function completeAccountStats(body: Record<string, unknown>): StatsAccountStats {
  return {
    total: body.total as number,
    newInRange: body.newInRange as number,
    activeInRange: body.activeInRange as number,
    returningInRange: typeof body.returningInRange === "number" ? body.returningInRange : 0,
    previous: isAccountPeriod(body.previous) ? body.previous : null,
    newByDay: dayCounts(body.newByDay),
    activeByDay: dayCounts(body.activeByDay),
    engagement: Array.isArray(body.engagement)
      ? body.engagement.filter((bucket): bucket is { label: string; value: number } =>
        isObject(bucket) && typeof bucket.label === "string" && typeof bucket.value === "number")
      : [],
    engagementBase: typeof body.engagementBase === "number" ? body.engagementBase : 0,
    activeSince: typeof body.activeSince === "number" ? body.activeSince : null,
    excluded: typeof body.excluded === "number" ? body.excluded : 0,
    cohorts: (body.cohorts as StatsAccountStats["cohorts"]).filter((cohort) =>
      isObject(cohort) && typeof cohort.weekStart === "number" && typeof cohort.size === "number" &&
      Array.isArray(cohort.active)),
    /* An older app answers without events; the dashboard then shows none rather than nothing. */
    events: isCountRecord(body.events) ? body.events : {},
  };
}

function dayCounts(value: unknown): { day: number; count: number }[] {
  if (!Array.isArray(value)) return [];
  return value.filter((point): point is { day: number; count: number } =>
    isObject(point) && typeof point.day === "number" && typeof point.count === "number");
}

function isAccountPeriod(value: unknown): value is StatsAccountPeriod {
  return isObject(value) && typeof value.total === "number" && typeof value.newAccounts === "number" &&
    typeof value.active === "number" && typeof value.returning === "number";
}

function isCountRecord(value: unknown): value is Record<string, number> {
  return isObject(value) && !Array.isArray(value) &&
    Object.values(value).every((count) => typeof count === "number");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
