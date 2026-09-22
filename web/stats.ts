import {
  INSTALL_CONVERSION_DAYS,
  STATS_RANGES,
  type StatsAccounts,
  type StatsAccountStats,
  type StatsBreakdownItem,
  type StatsRange,
  type StatsRetentionCohort,
  type StatsSeriesPoint,
  type StatsSnapshot,
  type UniqueSurface,
} from "../shared/stats";
import { DAY_MS, peopleCountedSince } from "../shared/stats-snapshot";
import {
  accountsInsight,
  deltaChip,
  formatDuration,
  formatPercent,
  funnelInsight,
  humanize,
  integerFormatter,
  numberFormatter,
  ratio,
  sessionsInsight,
  trafficInsight,
} from "../shared/stats-copy";
import { RELEASE_CHECKSUMS_PATH, RELEASE_VERSION } from "../shared/release";
import "./stats.css";

type SeriesKey = "sessions" | "started" | "shares" | "collaborations" | "pageViews" | "installs";

interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

/**
 * One moment on a chart, and the value of each series at it.
 *
 * The trend the Worker sends is one shape; the accounts app's days are
 * another, and both are drawn by the same code, so both are turned into this
 * first rather than the chart learning about either of them.
 */
interface ChartPoint {
  at: number;
  values: Record<string, number>;
}

function trendPoints(trend: StatsSeriesPoint[]): ChartPoint[] {
  return trend.map((point) => ({
    at: point.at,
    values: {
      sessions: point.sessions,
      started: point.started,
      shares: point.shares,
      collaborations: point.collaborations,
      pageViews: point.pageViews,
      installs: point.installs,
    },
  }));
}

const ACTIVITY_SERIES: ChartSeries[] = [
  { key: "sessions", label: "Created", color: "#8eafff" },
  { key: "shares", label: "Shared", color: "#75dac2" },
  { key: "collaborations", label: "Collaborated", color: "#d7a6ff" },
];
const TRAFFIC_SERIES: ChartSeries[] = [
  { key: "pageViews", label: "Page views by people", color: "#9ab7e8" },
];
let activeDashboardCleanup: (() => void) | null = null;
let statsRenderId = 0;

export function renderStatsDashboard(root: HTMLElement): void {
  activeDashboardCleanup?.();
  activeDashboardCleanup = null;
  const renderId = ++statsRenderId;
  document.documentElement.classList.add("stats-document");
  document.body.classList.add("stats-document");
  document.title = "Statistics — shell.online";
  setMeta("description", "Private aggregate product statistics for shell.online.");
  setMeta("robots", "noindex, nofollow, noarchive");
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute(
    "href",
    "https://stats.shell.online/",
  );
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    "#090c13",
  );

  root.innerHTML = renderStatsGate();
  void (async () => {
    try {
      const response = await fetch("/api/stats/auth", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (renderId !== statsRenderId) return;
      if (response.ok) {
        const status = await response.json() as { authenticated?: boolean };
        if (status.authenticated) {
          activeDashboardCleanup = renderAuthenticatedDashboard(root);
          return;
        }
      }
      renderStatsLogin(
        root,
        response.status === 503 ? "The dashboard password is not configured yet." : "",
      );
    } catch {
      if (renderId === statsRenderId) {
        renderStatsLogin(root, "Couldn’t reach the dashboard. Try again.");
      }
    }
  })();
}

function renderStatsGate(): string {
  return `
    <section class="stats-page stats-gate-page">
      <div class="stats-cloud cloud-one" aria-hidden="true"></div>
      <div class="stats-cloud cloud-two" aria-hidden="true"></div>
      <a class="stats-wordmark stats-gate-wordmark" href="https://shell.online/" aria-label="shell.online home">
        <span>shell</span><i>.</i>online
      </a>
      <div class="stats-gate-loading" role="status">
        <i></i>
        <span>Opening private statistics</span>
      </div>
    </section>
  `;
}

function renderStatsLogin(root: HTMLElement, message = ""): void {
  activeDashboardCleanup?.();
  activeDashboardCleanup = null;
  root.innerHTML = `
    <section class="stats-page stats-login-page">
      <div class="stats-cloud cloud-one" aria-hidden="true"></div>
      <div class="stats-cloud cloud-two" aria-hidden="true"></div>
      <a class="stats-wordmark stats-login-wordmark" href="https://shell.online/" aria-label="shell.online home">
        <span>shell</span><i>.</i>online
      </a>
      <main class="stats-login-main">
        <div class="stats-login-copy">
          <span class="stats-eyebrow">Private product signal</span>
          <h1>The quiet<br>control room.</h1>
          <p>Aggregate activity for shell.online. One password, no accounts.</p>
        </div>
        <form id="stats-login-form" class="stats-login-card">
          <div class="stats-login-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
          <span class="stats-login-kicker">Owner access</span>
          <h2>Open statistics</h2>
          <label for="stats-password">Password</label>
          <div class="stats-password-field">
            <input id="stats-password" name="password" type="password" maxlength="256" autocomplete="current-password" required autofocus>
            <span aria-hidden="true">••••••••</span>
          </div>
          <button id="stats-login-submit" type="submit">
            <span>Enter dashboard</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 7l5 5-5 5"></path></svg>
          </button>
          <p id="stats-login-error" class="stats-login-error" role="alert">${escapeHtml(message)}</p>
          <small>Protected by the shell.online Worker. The password never enters analytics.</small>
        </form>
      </main>
      <footer class="stats-login-footer">
        <span>Counts only. No terminal contents.</span>
        <a href="${RELEASE_CHECKSUMS_PATH}">v${RELEASE_VERSION} · SHA-256</a>
      </footer>
    </section>
  `;

  const form = requiredStatsElement<HTMLFormElement>("stats-login-form");
  const input = requiredStatsElement<HTMLInputElement>("stats-password");
  const submit = requiredStatsElement<HTMLButtonElement>("stats-login-submit");
  const error = requiredStatsElement("stats-login-error");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = input.value;
    input.value = "";
    error.textContent = "";
    submit.disabled = true;
    submit.classList.add("loading");
    void (async () => {
      try {
        const response = await fetch("/api/stats/login", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (response.ok) {
          activeDashboardCleanup = renderAuthenticatedDashboard(root);
          return;
        }
        error.textContent = response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : response.status === 503
            ? "The dashboard password is not configured yet."
            : "That password isn’t right.";
      } catch {
        error.textContent = "Couldn’t reach the dashboard. Try again.";
      } finally {
        submit.disabled = false;
        submit.classList.remove("loading");
        input.focus();
      }
    })();
  });
}

function renderAuthenticatedDashboard(root: HTMLElement): () => void {

  root.innerHTML = `
    <section class="stats-page">
      <div class="stats-cloud cloud-one" aria-hidden="true"></div>
      <div class="stats-cloud cloud-two" aria-hidden="true"></div>
      <header class="stats-nav">
        <a class="stats-wordmark" href="https://shell.online/" aria-label="shell.online home">
          <span>shell</span><i>.</i>online
        </a>
        <div class="stats-nav-title">
          <span>Private analytics</span>
          <b><i></i> Password protected</b>
        </div>
        <div class="stats-nav-actions">
          <div class="stats-ranges" role="group" aria-label="Statistics range">
            ${STATS_RANGES.map((range) => `
              <button type="button" data-range="${range}" aria-pressed="${range === "7d"}">
                ${range === "all" ? "All" : range}
              </button>
            `).join("")}
          </div>
          <button id="stats-refresh" class="stats-refresh" type="button" aria-label="Refresh statistics" title="Refresh statistics">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 8.5A8 8 0 1 0 20 15M19.5 3.5v5h-5"></path></svg>
          </button>
          <button id="stats-logout" class="stats-logout" type="button" aria-label="Lock dashboard" title="Lock dashboard">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5.5H6.8A1.8 1.8 0 0 0 5 7.3v9.4a1.8 1.8 0 0 0 1.8 1.8h2.7M13 8l4 4-4 4M17 12H9"></path></svg>
          </button>
        </div>
      </header>
      <main class="stats-main">
        <section class="stats-intro">
          <div>
            <span class="stats-eyebrow">Aggregate product signal</span>
            <h1>What shell.online<br>is doing.</h1>
            <p id="stats-live" class="stats-live">Checking what is live…</p>
          </div>
          <div class="stats-freshness">
            <span id="stats-state"><i></i> Loading live metrics</span>
            <time id="stats-updated">—</time>
          </div>
        </section>
        <div id="stats-content" class="stats-content" aria-live="polite" aria-busy="true">
          ${renderSkeleton()}
        </div>
      </main>
      <footer class="stats-footer">
        <span>Counts and keyed hashes only. No commands, terminal contents, IP addresses, session IDs, or user profiles.</span>
        <a href="${RELEASE_CHECKSUMS_PATH}">v${RELEASE_VERSION} · SHA-256</a>
      </footer>
    </section>
  `;

  const content = requiredStatsElement("stats-content");
  const state = requiredStatsElement("stats-state");
  const updated = requiredStatsElement<HTMLTimeElement>("stats-updated");
  const refresh = requiredStatsElement<HTMLButtonElement>("stats-refresh");
  const logout = requiredStatsElement<HTMLButtonElement>("stats-logout");
  const rangeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-range]"));
  let selectedRange: StatsRange = "7d";
  let activeRequest: AbortController | null = null;
  let refreshTimer: number | undefined;
  let stopped = false;

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    activeRequest?.abort();
    window.clearInterval(refreshTimer);
    window.removeEventListener("beforeunload", cleanup);
    if (activeDashboardCleanup === cleanup) activeDashboardCleanup = null;
  };

  const load = async (announce = false): Promise<void> => {
    if (stopped) return;
    activeRequest?.abort();
    activeRequest = new AbortController();
    refresh.classList.add("loading");
    if (announce) {
      state.className = "refreshing";
      state.innerHTML = "<i></i> Refreshing";
    }
    try {
      const response = await fetch(`/api/stats?range=${selectedRange}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: activeRequest.signal,
      });
      if (response.status === 401) {
        cleanup();
        renderStatsLogin(root, "Your dashboard session expired.");
        return;
      }
      if (!response.ok) throw new Error(`Statistics unavailable (${response.status})`);
      const snapshot = await response.json() as StatsSnapshot;
      if (snapshot.version !== 2) throw new Error("Unsupported statistics response");
      renderSnapshot(content, snapshot);
      content.setAttribute("aria-busy", "false");
      const generated = new Date(snapshot.generatedAt);
      updated.dateTime = generated.toISOString();
      updated.textContent = `Updated ${formatRelativeTime(snapshot.generatedAt)}`;
      state.className = "live";
      state.innerHTML = "<i></i> Live aggregate";
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      state.className = "error";
      state.innerHTML = "<i></i> Metrics unavailable";
      if (content.getAttribute("aria-busy") === "true") {
        content.innerHTML = `
          <section class="stats-error">
            <span>Couldn’t load the dashboard.</span>
            <p>${escapeHtml(error instanceof Error ? error.message : "Try again in a moment.")}</p>
            <button type="button" id="stats-retry">Try again</button>
          </section>
        `;
        document.querySelector<HTMLButtonElement>("#stats-retry")?.addEventListener(
          "click",
          () => void load(true),
        );
      }
    } finally {
      refresh.classList.remove("loading");
    }
  };

  for (const button of rangeButtons) {
    button.addEventListener("click", () => {
      const range = button.dataset.range;
      if (!isClientStatsRange(range) || range === selectedRange) return;
      selectedRange = range;
      for (const candidate of rangeButtons) {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      }
      content.classList.add("changing");
      void load(true).finally(() => content.classList.remove("changing"));
    });
  }
  refresh.addEventListener("click", () => void load(true));
  logout.addEventListener("click", () => {
    logout.disabled = true;
    cleanup();
    void fetch("/api/stats/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    }).finally(() => renderStatsLogin(root));
  });
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void load(false);
  }, 20_000);
  window.addEventListener("beforeunload", cleanup, { once: true });
  void load(false);
  return cleanup;
}

function renderSnapshot(container: HTMLElement, snapshot: StatsSnapshot): void {
  const metrics = snapshot.metrics;
  const figures = snapshot.figures;
  const audiences = snapshot.audiences;
  const previous = snapshot.previous;
  const rangeLabel = snapshot.range === "all" ? "all time" : `last ${snapshot.range}`;
  const priorLabel = snapshot.range === "all" ? "" : `the ${snapshot.range} before`;
  const trend = trendPoints(snapshot.trend);
  const outcomes = snapshot.breakdowns.outcomes;
  const endedSessions = outcomes.reduce((sum, item) => sum + item.value, 0);
  const people = snapshot.uniques;
  const site = people.surfaces.site;
  const cli = people.surfaces.cli;
  /*
   * People are counted from the day the salt was set, events from the first
   * event. A people figure over fewer days than the count beside it says so,
   * or thirty days of views next to one day of people reads as nonsense.
   */
  const peopleSince = peopleCountedSince(people, snapshot.rangeStart);
  /* Plain text: renderKpi escapes its detail. */
  const visitorsNote = peopleNote(snapshot, "site");
  const machinesNote = peopleNote(snapshot, "cli");
  const totalViews = metrics.landingViews + metrics.docsViews;
  const otherViews = audiences.views.tools + audiences.views.unknown;
  const ctaByLink = snapshot.targets
    .filter((metric) => metric.event === "cta_click")
    .map((metric) => ({ label: metric.target, value: metric.count }))
    .sort((left, right) => right.value - left.value);
  const installsByPlatform = snapshot.targets
    .filter((metric) => metric.event === "binary_download")
    .map((metric) => ({ label: metric.target, value: metric.count }))
    .sort((left, right) => right.value - left.value);
  const installerAudience = [
    { label: "Fetched by command-line tools", value: audiences.installer.tools },
    { label: "Read in a browser", value: audiences.installer.browsers },
    { label: "Fetched by crawlers", value: audiences.installer.crawlers },
    { label: "No user agent", value: audiences.installer.unknown },
  ].filter((item) => item.value > 0);
  const delta = (current: number, before: number | null | undefined): string =>
    renderDelta(current, before ?? null, priorLabel);

  renderLive(metrics);

  container.innerHTML = `
    ${people.configured ? "" : `
      <p class="stats-note">
        <span aria-hidden="true">●</span>
        <span>People are not being counted yet. Set <code>STATS_VISITOR_SALT</code> (16 or more characters) on the Worker and every unique, new, returning and retention figure below fills in from that moment. Event counts are unaffected.</span>
      </p>
    `}
    <section class="stats-kpis" aria-label="Headline statistics">
      ${renderKpi(
        "Visitors",
        people.configured ? site.unique : "—",
        people.configured ? visitorsNote : "people are not counted yet",
        snapshot.trend,
        "pageViews",
        "silver",
        people.configured ? delta(site.unique, previous?.people?.site) : "",
      )}
      ${renderKpi(
        "Views by people",
        figures.siteViews,
        figures.crawlerViews === 0
          ? "no crawler views in this range"
          : `${integerFormatter.format(figures.crawlerViews)} more by crawlers, kept out`,
        snapshot.trend,
        "pageViews",
        "blue",
        delta(figures.siteViews, previous?.figures.siteViews),
      )}
      ${renderKpi(
        "Binary downloads",
        figures.installs,
        `${integerFormatter.format(figures.installsReported)} installer success reports · not inferred from downloads`,
        snapshot.trend,
        "installs",
        "amber",
        delta(figures.installs, previous?.figures.installs),
      )}
      ${renderKpi(
        "Sessions started",
        figures.sessionsStarted,
        people.configured
          ? `on ${integerFormatter.format(cli.unique)} machine${cli.unique === 1 ? "" : "s"} · ${machinesNote}`
          : `${integerFormatter.format(metrics.sessionsCreated)} created`,
        snapshot.trend,
        "started",
        "violet",
        delta(figures.sessionsStarted, previous?.figures.sessionsStarted),
      )}
      ${renderKpi(
        "Opened in a browser",
        figures.sharesOpened,
        figures.sessionsStarted === 0
          ? "no sessions in this range"
          : `${formatPercent(ratio(figures.sharesOpened, figures.sessionsStarted))} of sessions started`,
        snapshot.trend,
        "shares",
        "green",
        delta(figures.sharesOpened, previous?.figures.sharesOpened),
      )}
      ${renderKpi(
        "Typed from a browser",
        figures.collaborations,
        figures.sharesOpened === 0
          ? "no opened sessions yet"
          : `${formatPercent(ratio(figures.collaborations, figures.sharesOpened))} of opened sessions`,
        snapshot.trend,
        "collaborations",
        "pink",
        delta(figures.collaborations, previous?.figures.collaborations),
      )}
    </section>

    <article class="stats-panel funnel-panel">
      <header class="panel-heading">
        <div><span class="panel-kicker">From a first look to a first keystroke</span><h2>Funnel</h2></div>
        <span class="panel-range">${escapeHtml(rangeLabel)}</span>
      </header>
      <p class="panel-insight">${escapeHtml(funnelInsight(snapshot))}</p>
      ${renderFunnel(snapshot)}
      ${peopleSince === null ? "" : `<p class="cohort-empty">People have been counted since ${escapeHtml(formatDay(peopleSince))}; event counts run from the start of the range. Until the range begins after that day, a people figure covers fewer days than the count beside it.</p>`}
      ${renderInstallConversion(snapshot)}
      ${renderUniquesStrip(snapshot)}
    </article>

    ${renderAccounts(snapshot)}

    <section class="stats-wide-grid">
      <article class="stats-panel traffic-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">Who came</span><h2>Traffic</h2></div>
          <strong>${integerFormatter.format(totalViews)} <small>views</small></strong>
        </header>
        <p class="panel-insight">${escapeHtml(trafficInsight(snapshot))}</p>
        ${renderTimeChart("traffic", trend, TRAFFIC_SERIES, snapshot.trendStepMs, true)}
        <div class="traffic-split is-wide">
          <span class="split-people"><i></i>People <b>${integerFormatter.format(audiences.views.browsers)}</b></span>
          <span class="split-crawlers"><i></i>Crawlers <b>${integerFormatter.format(audiences.views.crawlers)}</b></span>
          <span class="split-tools"><i></i>Tools <b>${integerFormatter.format(otherViews)}</b></span>
          <span class="split-page"><i></i>Landing <b>${integerFormatter.format(metrics.landingViews)}</b></span>
          <span class="split-page"><i></i>Docs <b>${integerFormatter.format(metrics.docsViews)}</b></span>
          <span class="split-page"><i></i>Shared terminals <b>${integerFormatter.format(metrics.terminalViews)}</b></span>
          <span class="split-page"><i></i>Unknown paths <b>${integerFormatter.format(metrics.unknownPaths)}</b></span>
          <span class="split-page"><i></i>404s <b>${integerFormatter.format(metrics.notFoundViews)}</b></span>
        </div>
      </article>
      ${renderBreakdown(
        "Sources",
        "Where landing visits came from",
        snapshot.breakdowns.referrers,
        "referrer",
        "Landing page only. Most browsers send no referrer, so Direct is also everyone they hid.",
      )}
    </section>

    <section class="stats-breakdown-grid">
      ${renderBreakdown("Pages", "Document views by page, every audience", snapshot.breakdowns.pages, "page")}
      ${renderBreakdown("Devices", "Page views by device class", snapshot.breakdowns.devices, "device")}
      ${renderBreakdown(
        "Sign-up clicks",
        "Which landing link was clicked",
        ctaByLink,
        "cta",
        "Accounts also start in the app, from an invite, or from the CLI, none of which pass here.",
      )}
    </section>

    <section class="stats-wide-grid">
      <article class="stats-panel activity-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">Throughput</span><h2>Session activity</h2></div>
          <div class="chart-legend">
            ${ACTIVITY_SERIES.map((series) => `<span><i style="--legend:${series.color}"></i>${series.label}</span>`).join("")}
          </div>
        </header>
        <p class="panel-insight">${escapeHtml(sessionsInsight(snapshot))}</p>
        ${renderTimeChart("activity", trend, ACTIVITY_SERIES, snapshot.trendStepMs)}
      </article>

      <article class="stats-panel outcomes-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">Reliability</span><h2>Session outcomes</h2></div>
          <strong>${integerFormatter.format(endedSessions)} <small>ended</small></strong>
        </header>
        ${renderDonut(outcomes)}
        <div class="quality-strip">
          <span><small>Average lifetime</small><b>${formatDuration(metrics.averageDurationSeconds)}</b></span>
          <span><small>Longest lifetime</small><b>${formatDuration(metrics.longestDurationSeconds)}</b></span>
          <span><small>Avg peak audience</small><b>${numberFormatter.format(metrics.averagePeakViewers)}</b></span>
          <span><small>Largest audience</small><b>${integerFormatter.format(metrics.maximumPeakViewers)}</b></span>
          <span><small>Link waited for its first open</small><b>${metrics.sharesOpened === 0 ? "—" : formatDuration(metrics.averageSecondsToOpen)}</b></span>
          <span><small>Open to first keystroke</small><b>${metrics.collaborations === 0 ? "—" : formatDuration(metrics.averageSecondsToType)}</b></span>
          <span><small>A viewer stayed</small><b>${metrics.averageViewerSeconds === 0 ? "—" : formatDuration(metrics.averageViewerSeconds)}</b></span>
          <span><small>Viewers turned away</small><b>${integerFormatter.format(metrics.viewersRejected)}</b></span>
        </div>
      </article>
    </section>

    <section class="stats-breakdown-grid">
      ${renderBreakdown("CLI clients", "Versions creating sessions", snapshot.breakdowns.clients, "client")}
      ${renderRates(
        "Typed, by device",
        "Of sessions opened on each device class, how many were typed into",
        snapshot.breakdowns.openedDevices.map((opened) => ({
          label: opened.label,
          numerator: snapshot.breakdowns.typedDevices.find((typed) => typed.label === opened.label)?.value ?? 0,
          denominator: opened.value,
        })),
        "Device is the first viewer's for opened and the first typist's for typed, so a phone that watched while a laptop typed lands on both sides.",
      )}
      ${renderBreakdown(
        "Turned away",
        "Browsers that opened a link and got nothing",
        [
          ...snapshot.breakdowns.rejections,
          ...(metrics.inputDenied > 0 ? [{ label: "typed_into_read_only", value: metrics.inputDenied }] : []),
        ],
        "rejection",
        "A full, expired or unknown session closes the link at once; typing into a read-only session is refused but the viewer stays. None of these appear as opened.",
      )}
    </section>

    <section class="stats-breakdown-grid">
      ${renderBreakdown(
        "Installer",
        "Who fetched the install script",
        installerAudience,
        "download",
        metrics.skillDownloads === 0
          ? "A script fetch does not prove it was executed."
          : `A script fetch does not prove it was executed. The agent skill file was fetched ${integerFormatter.format(metrics.skillDownloads)} time${metrics.skillDownloads === 1 ? "" : "s"}.`,
      )}
      ${renderBreakdown(
        "Downloads by platform",
        "Release binaries served",
        installsByPlatform,
        "download",
        "Homebrew and source builds are not counted.",
      )}
      ${renderBreakdown(
        "Installer outcomes",
        "How installs ended, by the script's own account",
        snapshot.breakdowns.installOutcomes,
        "outcome",
        "One word sent by the installer at its end, unless SHELL_ONLINE_INSTALL_REPORT=0 was set. A machine that never reached the end of the script reports nothing.",
      )}
    </section>

    <section class="stats-people-grid">
      ${renderCohorts(
        "Machines that came back",
        "CLI hosts by the week they first started a session",
        snapshot.retention.cli,
        snapshot.retention.weeks,
        people.configured,
        "No machine has started a session in these weeks yet.",
      )}
      ${renderCohorts(
        "Visitors that came back",
        "Site visitors by the week they first arrived",
        snapshot.retention.site,
        snapshot.retention.weeks,
        people.configured,
        "No visitor has been counted in these weeks yet.",
      )}
    </section>

    <details class="stats-panel raw-metrics">
      <summary><span><small>Complete event ledger</small>Every tracked aggregate, every audience</span><i></i></summary>
      <div class="metrics-table-wrap">
        <table>
          <thead><tr><th>Event</th><th>Target</th><th>Count</th><th>Value sum</th><th>Maximum</th></tr></thead>
          <tbody>
            ${snapshot.targets.map((metric) => `
              <tr>
                <td>${escapeHtml(humanize(metric.event))}</td>
                <td>${escapeHtml(humanize(metric.target))}</td>
                <td>${integerFormatter.format(metric.count)}</td>
                <td>${numberFormatter.format(metric.value)}</td>
                <td>${numberFormatter.format(metric.maximum)}</td>
              </tr>
            `).join("") || '<tr><td colspan="5">No events in this range yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </details>

    <div class="collection-note">
      <span>Showing ${escapeHtml(rangeLabel)}${previous ? `, compared with ${escapeHtml(priorLabel)}` : ""}.</span>
      <span>${snapshot.collectingSince ? `Collecting exact dashboard metrics since ${formatDate(snapshot.collectingSince)}.` : "Waiting for the first event."}</span>
      ${people.configured && people.since !== null ? `<span>Counting people since ${escapeHtml(formatDay(people.since, "long"))}.</span>` : ""}
      <span>Crawlers are requests whose user agent says so; they stay in the ledger and out of every figure about people.</span>
      ${accountsExcludedNote(snapshot.accounts)}
      <span>People are keyed hashes of address and browser family, forgotten ${people.memoryDays} days after they were last seen; a person seen again after that counts as new.</span>
    </div>
  `;

  bindChartInteraction(container.querySelector("#activity-chart"), trend, ACTIVITY_SERIES, snapshot.trendStepMs);
  bindChartInteraction(container.querySelector("#traffic-chart"), trend, TRAFFIC_SERIES, snapshot.trendStepMs);
  bindChartInteraction(container.querySelector("#accounts-chart"), accountPoints(snapshot.accounts), ACCOUNT_SERIES, DAY_MS);
}

/** What is happening this minute, under the page title, so it is not mistaken for a range figure. */
function renderLive(metrics: StatsSnapshot["metrics"]): void {
  const live = document.getElementById("stats-live");
  if (!live) return;
  if (metrics.activeSessions === 0 && metrics.activeViewers === 0) {
    live.textContent = "Nothing is live right now.";
    return;
  }
  live.innerHTML = `Live now: <b>${integerFormatter.format(metrics.activeSessions)}</b> session${metrics.activeSessions === 1 ? "" : "s"}, <b>${integerFormatter.format(metrics.activeViewers)}</b> viewer${metrics.activeViewers === 1 ? "" : "s"} connected.`;
}

/** The chip beside a headline figure: how it moved against the period before, or nothing. */
function renderDelta(current: number, before: number | null, priorLabel: string): string {
  const chip = deltaChip(current, before, priorLabel);
  if (chip === null) return "";
  return `<em class="kpi-delta ${chip.tone}" title="${escapeHtml(chip.title)}">${chip.text}</em>`;
}

function renderKpi(
  label: string,
  value: number | string,
  detail: string,
  trend: StatsSeriesPoint[],
  key: SeriesKey,
  tone: string,
  delta = "",
): string {
  return `
    <article class="kpi-card tone-${tone}">
      <div><span>${escapeHtml(label)}</span><strong>${typeof value === "number" ? integerFormatter.format(value) : escapeHtml(value)}${delta}</strong></div>
      <div class="kpi-spark">${renderSparkline(trend.map((point) => point[key]))}</div>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}

function renderSparkline(values: number[]): string {
  const width = 118;
  const height = 34;
  const maximum = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = values.length <= 1 ? width : index * width / (values.length - 1);
    const y = height - 3 - value / maximum * (height - 7);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"></polyline></svg>`;
}

/*
 * `stepMs` is how much time one point covers, not which range is selected:
 * the trend's step changes with the range, and the accounts chart is always a
 * day whatever the range is. It decides whether an axis label and a tooltip
 * name an hour or a day.
 */
function renderTimeChart(
  id: string,
  points: ChartPoint[],
  series: ChartSeries[],
  stepMs: number,
  compact = false,
): string {
  const width = 760;
  const height = compact ? 150 : 250;
  const top = 16;
  const bottom = compact ? 24 : 32;
  const usableHeight = height - top - bottom;
  const maximum = Math.max(1, ...points.flatMap((point) => series.map((item) => point.values[item.key] ?? 0)));
  const roundedMaximum = niceMaximum(maximum);
  const paths = series.map((item, index) => {
    const coordinates = points.map((point, pointIndex) => ({
      x: points.length <= 1 ? width / 2 : pointIndex * width / (points.length - 1),
      y: top + usableHeight - (point.values[item.key] ?? 0) / roundedMaximum * usableHeight,
    }));
    const line = smoothPath(coordinates);
    const area = coordinates.length === 0
      ? ""
      : `${line} L${coordinates.at(-1)?.x.toFixed(2)} ${(top + usableHeight).toFixed(2)} L0 ${(top + usableHeight).toFixed(2)} Z`;
    return `
      ${index === 0 ? `<path class="chart-area" d="${area}" fill="url(#${id}-fill)"></path>` : ""}
      <path class="chart-line series-${item.key}" d="${line}" style="--series:${item.color}"></path>
    `;
  }).join("");
  const yGrid = Array.from({ length: 5 }, (_, index) => {
    const y = top + usableHeight * index / 4;
    const value = roundedMaximum * (1 - index / 4);
    return `<g><line x1="0" y1="${y}" x2="${width}" y2="${y}"></line><text x="0" y="${Math.max(9, y - 4)}">${integerFormatter.format(value)}</text></g>`;
  }).join("");
  const xLabels = axisLabelIndexes(points.length).map((index) => {
    const point = points[index];
    const x = points.length <= 1 ? width / 2 : index * width / (points.length - 1);
    return `<text x="${x}" y="${height - 3}" text-anchor="${index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}">${point ? escapeHtml(formatChartTime(point.at, stepMs)) : ""}</text>`;
  }).join("");

  return `
    <div id="${id}-chart" class="time-chart ${compact ? "compact" : ""}" data-maximum="${roundedMaximum}">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(series.map((item) => item.label).join(", "))} over time">
        <defs>
          <linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${series[0].color}" stop-opacity=".3"></stop>
            <stop offset="1" stop-color="${series[0].color}" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <g class="chart-grid">${yGrid}</g>
        <g class="chart-paths">${paths}</g>
        <g class="chart-x-labels">${xLabels}</g>
      </svg>
      <div class="chart-guide" aria-hidden="true"></div>
      <div class="chart-tooltip" role="status"></div>
    </div>
  `;
}

/** Which surface a funnel step's people are counted on, for the day their count starts. */
const STEP_SURFACES: Record<string, UniqueSurface> = { visited: "site", installer: "install", session: "cli", opened: "viewer" };

function renderFunnel(snapshot: StatsSnapshot): string {
  const steps = snapshot.funnel;
  const sinceFor = (key: string): string => {
    const surface = STEP_SURFACES[key];
    const since = surface === undefined ? null : peopleCountedSince(snapshot.uniques, snapshot.rangeStart, surface);
    return since === null ? "" : ` since ${escapeHtml(formatDay(since))}`;
  };
  const colors = ["#9ab7e8", "#8eafff", "#819de5", "#f4bd78", "#8eafff", "#75dac2", "#d7a6ff"];
  const maximum = Math.max(1, ...steps.map((step) => step.count));
  return `
    <div class="funnel-steps">
      ${steps.map((step, index) => {
        const width = step.count === 0 ? 1.5 : Math.max(4, step.count / maximum * 100);
        const basis = step.basis === null ? null : steps.find((candidate) => candidate.key === step.basis) ?? null;
        const basisCount = step.basisCount ?? basis?.count ?? 0;
        const basisLabel = step.basisLabel ?? basis?.label.toLowerCase() ?? "";
        const share = basis === null
          ? (index === 0 ? "the whole path starts here" : "its own population")
          : basisCount === 0
            ? `no ${basisLabel} to compare with`
            : `${formatPercent(ratio(step.count, basisCount))} of ${basisLabel}`;
        const excluded = step.excluded.length === 0
          ? ""
          : `<em class="funnel-excluded">+ ${step.excluded.map((entry) => `${integerFormatter.format(entry.count)} ${escapeHtml(entry.label)}`).join(" · ")}</em>`;
        return `
          <div class="funnel-step">
            <span>${escapeHtml(step.label)}</span>
            <b>${integerFormatter.format(step.count)}${step.unique === null ? "" : `<small>${integerFormatter.format(step.unique)} ${step.unique === 1 ? "person" : "people"}${sinceFor(step.key)}</small>`}</b>
            <div><i style="width:${width}%;--funnel:${colors[index % colors.length]}"></i></div>
            <em>${escapeHtml(share)}</em>
            ${excluded}
            <small>${escapeHtml(step.note)}</small>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

/**
 * The one line that crosses from the installer to the CLI: of the machines
 * that installed long enough ago to tell, how many started a session within
 * the window. Fresh installs are named separately rather than counted as
 * misses.
 */
function renderInstallConversion(snapshot: StatsSnapshot): string {
  const conversion = snapshot.installConversion;
  if (conversion === null || conversion.installers === 0) return "";
  const fresh = conversion.installers - conversion.matured;
  const verdict = conversion.matured === 0
    ? `${integerFormatter.format(conversion.installers)} addresses fetched an installer or binary within the last ${INSTALL_CONVERSION_DAYS} days, too recently to evaluate follow-up CLI requests.`
    : `Of ${integerFormatter.format(conversion.matured)} addresses that first fetched an installer or binary at least ${INSTALL_CONVERSION_DAYS} days ago, ${integerFormatter.format(conversion.started)} (${formatPercent(ratio(conversion.started, conversion.matured))}) made a session-creation request within ${INSTALL_CONVERSION_DAYS} days.${fresh > 0 ? ` ${integerFormatter.format(fresh)} are too recent to evaluate.` : ""}`;
  return `<p class="cohort-empty">${escapeHtml(verdict)} This approximate address-based join does not prove installation or a working session. Shared networks can merge users and network changes can split one user.</p>`;
}

/*
 * What to say beside a people figure. New means first seen since the range
 * began, so until a whole range has passed since this surface's people were
 * first counted, everyone is new and the split says nothing: name the day it
 * starts to. The 24h range counts people by UTC day, which is two of them.
 */
function peopleNote(snapshot: StatsSnapshot, surface: UniqueSurface): string {
  const count = snapshot.uniques.surfaces[surface];
  const days = snapshot.range === "24h" ? " · by UTC day, so two days" : "";
  const since = peopleCountedSince(snapshot.uniques, snapshot.rangeStart, surface);
  if (since === null) return `${integerFormatter.format(count.new)} new · ${integerFormatter.format(count.returning)} returning${days}`;
  const knownFrom = formatDay(since + (snapshot.generatedAt - snapshot.rangeStart));
  return `counted since ${formatDay(since)}; new or returning cannot be told until ${knownFrom}${days}`;
}

function renderUniquesStrip(snapshot: StatsSnapshot): string {
  const people = snapshot.uniques;
  const cell = (label: string, surface: UniqueSurface): string => {
    const count = people.surfaces[surface];
    return `
      <span>
        <small>${escapeHtml(label)}</small>
        <b>${people.configured ? integerFormatter.format(count.unique) : "—"}</b>
        <em>${people.configured ? escapeHtml(peopleNote(snapshot, surface)) : "not counted"}</em>
      </span>
    `;
  };
  return `
    <div class="uniques-strip" aria-label="Distinct people by surface">
      ${cell("Visitors", "site")}
      ${cell("Installers", "install")}
      ${cell("CLI machines", "cli")}
      ${cell("Viewers", "viewer")}
    </div>
  `;
}

/*
 * A cohort grid: one row per week of first arrivals, one column per later
 * week, each cell the share of that cohort seen in that week. Cells for weeks
 * that have not happened yet are left blank rather than drawn as zero.
 */
function renderCohorts(
  title: string,
  kicker: string,
  cohorts: StatsRetentionCohort[],
  weeks: number,
  configured: boolean,
  empty: string,
): string {
  const later = weeks - 1;
  const columns = `78px 54px repeat(${later}, minmax(34px, 1fr))`;
  const head = [
    '<span class="cohort-head">Week of</span>',
    '<span class="cohort-head">People</span>',
    ...Array.from({ length: later }, (_, index) => `<span class="cohort-head">+${index + 1}</span>`),
  ].join("");
  const rows = cohorts.map((cohort) => {
    const cells = Array.from({ length: later }, (_, index) => {
      if (index >= cohort.active.length) return '<span class="cohort-cell is-future"></span>';
      const share = cohort.size === 0 ? 0 : cohort.active[index] / cohort.size;
      if (cohort.active[index] === 0) return '<span class="cohort-cell is-empty">0%</span>';
      return `<span class="cohort-cell" style="--heat:${share.toFixed(3)}" title="${integerFormatter.format(cohort.active[index])} of ${integerFormatter.format(cohort.size)}">${formatPercent(share)}</span>`;
    }).join("");
    return `<span class="cohort-week">${escapeHtml(formatWeek(cohort.weekStart))}</span><span class="cohort-size">${integerFormatter.format(cohort.size)}</span>${cells}`;
  }).join("");
  return `
    <article class="stats-panel cohort-panel">
      <header class="panel-heading">
        <div><span class="panel-kicker">${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2></div>
        <span class="panel-range">${weeks} weeks</span>
      </header>
      ${!configured
        ? '<p class="cohort-empty">Not counted until the Worker has a visitor salt.</p>'
        : cohorts.length === 0
          ? `<p class="cohort-empty">${escapeHtml(empty)}</p>`
          : `<div class="cohort-grid" style="grid-template-columns:${columns}" role="table" aria-label="${escapeHtml(title)}">${head}${rows}</div>`}
    </article>
  `;
}

/**
 * Accounts: the one exact count of people on this page.
 *
 * Everything else here is inferred from requests -- a keyed hash is the best
 * guess at a person that a page with no sign-in can make. An account is a
 * person who gave us an address and came back to it, so this panel is read
 * first and laid out to be read in one pass: how many there are and how that
 * moved, then how many of them are actually using it, then a day-by-day line
 * of both, then what they did and whether they stayed.
 */
function renderAccounts(snapshot: StatsSnapshot): string {
  const accounts = snapshot.accounts;
  if (accounts === null) return "";
  if ("error" in accounts) {
    return `
      <p class="stats-note">
        <span aria-hidden="true">●</span>
        <span>Account figures are linked but unavailable: ${escapeHtml(accounts.error)}. Check <code>APP_STATS_URL</code> and <code>APP_STATS_TOKEN</code> on the Worker and <code>STATS_TOKEN</code> on the app.</span>
      </p>
    `;
  }
  const rangeLabel = snapshot.range === "all" ? "all time" : `last ${snapshot.range}`;
  const priorLabel = snapshot.range === "all" ? "" : `the ${snapshot.range} before`;
  const previous = accounts.previous;
  const points = accountPoints(accounts);
  const signups = points.map((point) => point.values.signups);
  const active = points.map((point) => point.values.active);
  const stale = accounts.total - accounts.activeInRange;
  return `
    <header class="stats-section-head">
      <div>
        <span class="panel-kicker">The only exact count of people on this page</span>
        <h2>Accounts</h2>
      </div>
      <span class="panel-range">${escapeHtml(rangeLabel)}</span>
    </header>

    <section class="stats-kpis accounts-kpis" aria-label="Account statistics">
      ${renderAccountKpi(
        "Accounts",
        accounts.total,
        accounts.newInRange === 0
          ? `no new account in ${rangeLabel}`
          : `${integerFormatter.format(accounts.newInRange)} signed up in ${rangeLabel}`,
        signups,
        "blue",
        renderDelta(accounts.total, previous?.total ?? null, priorLabel),
      )}
      ${renderAccountKpi(
        "Signed up",
        accounts.newInRange,
        snapshot.range === "all" ? "every account there is" : `in ${rangeLabel}`,
        signups,
        "green",
        renderDelta(accounts.newInRange, previous?.newAccounts ?? null, priorLabel),
      )}
      ${renderAccountKpi(
        "Used the app",
        accounts.activeInRange,
        accounts.total === 0
          ? "no accounts yet"
          : `${formatPercent(ratio(accounts.activeInRange, accounts.total))} of all accounts · ${integerFormatter.format(stale)} did not`,
        active,
        "violet",
        renderDelta(accounts.activeInRange, previous?.active ?? null, priorLabel),
      )}
      ${renderAccountKpi(
        "Came back",
        accounts.returningInRange,
        snapshot.range === "all"
          ? "nothing comes before all time, so nothing here has come back to it"
          : accounts.activeInRange === 0
            ? "nobody used the app in this range"
            : `${formatPercent(ratio(accounts.returningInRange, accounts.activeInRange))} of the accounts that used it had signed up earlier`,
        active,
        "pink",
        renderDelta(accounts.returningInRange, previous?.returning ?? null, priorLabel),
      )}
    </section>

    <section class="stats-wide-grid">
      <article class="stats-panel accounts-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">Sign-ups, and the accounts that opened it</span><h2>Day by day</h2></div>
          <div class="chart-legend">
            ${ACCOUNT_SERIES.map((series) => `<span><i style="--legend:${series.color}"></i>${series.label}</span>`).join("")}
          </div>
        </header>
        <p class="panel-insight">${escapeHtml(accountsInsight(accounts, rangeLabel))}</p>
        ${points.length === 0
          ? '<p class="cohort-empty">No account has signed up yet.</p>'
          : renderTimeChart("accounts", points, ACCOUNT_SERIES, DAY_MS)}
        <p class="cohort-empty">Every day since the first account, whatever range is chosen above: accounts arrive a few a day, and a day is the smallest step that says anything. A day counts an account as active if it signed up or made a request that day.${accountsSinceNote(accounts)}</p>
      </article>

      <article class="stats-panel accounts-events-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">What they did</span><h2>In the app</h2></div>
          <span class="panel-range">${escapeHtml(rangeLabel)}</span>
        </header>
        ${renderAccountEvents(accounts.events)}
      </article>
    </section>

    <section class="stats-people-grid">
      ${renderEngagement(accounts)}
      ${renderCohorts(
        "Accounts that came back",
        "Accounts by the week they signed up",
        accounts.cohorts,
        snapshot.retention.weeks,
        true,
        "No account has signed up in these weeks yet.",
      )}
    </section>
  `;
}

/** The footer line that makes the exclusion visible wherever the reader stops. */
function accountsExcludedNote(accounts: StatsAccounts): string {
  if (accounts === null || "error" in accounts || accounts.excluded === 0) return "";
  return `<span>${integerFormatter.format(accounts.excluded)} of our own account${accounts.excluded === 1 ? " is" : "s are"} left out of every account figure, along with everything ${accounts.excluded === 1 ? "it" : "they"} did in the app. Set by <code>STATS_EXCLUDE</code> on the accounts app.</span>`;
}

/*
 * Used first, signed up second. An account is active on the day it signs up,
 * so the first line is never below the second: drawn this way the filled area
 * belongs to the larger of the two and neither line hides the other.
 */
const ACCOUNT_SERIES: ChartSeries[] = [
  { key: "active", label: "Used the app", color: "#8eafff" },
  { key: "signups", label: "Signed up", color: "#75dac2" },
];

/**
 * The account days as chart points, trimmed to start at the first day
 * anything happened. The app sends a fixed window of days whatever the range,
 * and a product ten days old would otherwise be drawn as eighty days of zero.
 */
function accountPoints(accounts: StatsAccounts): ChartPoint[] {
  if (accounts === null || "error" in accounts) return [];
  const active = new Map(accounts.activeByDay.map((point) => [point.day, point.count]));
  const points = accounts.newByDay.map((point) => ({
    at: point.day,
    values: { signups: point.count, active: active.get(point.day) ?? 0 },
  }));
  const first = points.findIndex((point) => point.values.signups > 0 || point.values.active > 0);
  return first === -1 ? [] : points.slice(first);
}

/** Says when the app started recording days, where that is younger than the accounts. */
function accountsSinceNote(accounts: StatsAccountStats): string {
  if (accounts.activeSince === null) return "";
  return ` Days have been recorded since ${formatDay(accounts.activeSince, "long")}; before that an account is only counted active on the day it signed up.`;
}

/**
 * How deeply accounts use the app: not how many came, but how many days each
 * of them has been in it. The bands are always all four, zeros included --
 * the shape of the distribution is the point, and hiding the empty end of it
 * would make one busy band look like the whole picture.
 */
function renderEngagement(accounts: StatsAccountStats): string {
  const maximum = Math.max(1, ...accounts.engagement.map((bucket) => bucket.value));
  return `
    <article class="stats-panel breakdown-panel kind-band">
      <header class="panel-heading">
        <div><span class="panel-kicker">Accounts by the days they have been in the app</span><h2>How much they use it</h2></div>
        <strong>${integerFormatter.format(accounts.engagementBase)}</strong>
      </header>
      <div class="breakdown-list">
        ${accounts.engagementBase === 0
          ? "<em>No account has signed up since days started being recorded.</em>"
          : accounts.engagement.map((bucket) => `
            <div>
              <span>${escapeHtml(humanize(bucket.label))}</span>
              <i><b style="width:${Math.max(2, bucket.value / maximum * 100)}%"></b></i>
              <strong>${integerFormatter.format(bucket.value)}</strong>
            </div>
          `).join("")}
      </div>
      <p class="cohort-empty">Over the accounts that signed up since days started being recorded. An older account is missing the days before that and would read here as one that never came back, so it is left out rather than counted against the product.</p>
    </article>
  `;
}

function renderAccountKpi(
  label: string,
  value: number,
  detail: string,
  values: number[],
  tone: string,
  delta: string,
): string {
  return `
    <article class="kpi-card tone-${tone}">
      <div><span>${escapeHtml(label)}</span><strong>${integerFormatter.format(value)}${delta}</strong></div>
      <div class="kpi-spark">${renderSparkline(values)}</div>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}

/** A dashboard day is a UTC day, so it is named in UTC wherever the reader is. */
function formatDay(at: number, month: "short" | "long" = "short"): string {
  return new Date(at).toLocaleDateString([], month === "long"
    ? { month, day: "numeric", year: "numeric", timeZone: "UTC" }
    : { month, day: "numeric", timeZone: "UTC" });
}

function formatWeek(weekStart: number): string {
  return formatDay(weekStart);
}

function renderDonut(items: StatsBreakdownItem[]): string {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const colors = ["#8eafff", "#75dac2", "#d7a6ff", "#f4bd78", "#6d7992"];
  let cursor = 0;
  const segments = total === 0
    ? "#202736 0 100%"
    : items.map((item, index) => {
      const start = cursor;
      cursor += item.value / total * 100;
      return `${colors[index % colors.length]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    }).join(",");
  return `
    <div class="donut-layout">
      <div class="donut" style="--donut:conic-gradient(${segments})">
        <div><strong>${integerFormatter.format(total)}</strong><small>sessions</small></div>
      </div>
      <div class="donut-legend">
        ${items.slice(0, 5).map((item, index) => `
          <span><i style="--legend:${colors[index % colors.length]}"></i>${escapeHtml(humanize(item.label))}<b>${integerFormatter.format(item.value)}</b></span>
        `).join("") || "<em>No sessions have ended in this range.</em>"}
      </div>
    </div>
  `;
}

/**
 * What accounts did, in the order the product hopes for: link a machine,
 * register a session, send it a command. Counts of things done, not of
 * accounts, since the app sends no identifiers with them -- and only what
 * customers did: the app counts our own separately and never sends it.
 */
function renderAccountEvents(events: Record<string, number>): string {
  const order = ["machine_linked", "session_registered", "command_sent", "vault_created", "invite_created", "invite_accepted", "feedback_sent"];
  const items = order.filter((key) => (events[key] ?? 0) > 0).map((key) => ({ label: key, value: events[key] }));
  if (items.length === 0) {
    return '<p class="cohort-empty">Nothing done in the app in this range: no machine linked, session registered, command sent, vault created, invite, or feedback. What we did ourselves is counted apart and never shown here.</p>';
  }
  const maximum = Math.max(1, ...items.map((item) => item.value));
  return `
    <div class="breakdown-list accounts-events">
      ${items.map((item) => `
        <div>
          <span>${escapeHtml(humanize(item.label))}</span>
          <i><b style="width:${Math.max(2, item.value / maximum * 100)}%"></b></i>
          <strong>${integerFormatter.format(item.value)}</strong>
        </div>
      `).join("")}
    </div>
    <p class="cohort-empty">Things done, not distinct accounts: one account linking three machines counts three times. What we did ourselves is counted apart and never shown here.</p>
  `;
}

/** A panel of rates: each row a share of its own denominator, not of a total. */
function renderRates(
  title: string,
  description: string,
  rows: { label: string; numerator: number; denominator: number }[],
  footnote = "",
): string {
  const shown = rows.filter((row) => row.denominator > 0).sort((left, right) => right.denominator - left.denominator);
  return `
    <article class="stats-panel breakdown-panel kind-rate">
      <header class="panel-heading">
        <div><span class="panel-kicker">${escapeHtml(description)}</span><h2>${escapeHtml(title)}</h2></div>
      </header>
      <div class="breakdown-list">
        ${shown.slice(0, 7).map((row) => `
          <div>
            <span>${escapeHtml(humanize(row.label))}</span>
            <i><b style="width:${Math.max(2, ratio(row.numerator, row.denominator) * 100)}%"></b></i>
            <strong>${formatPercent(ratio(row.numerator, row.denominator))} <small>${integerFormatter.format(row.numerator)} of ${integerFormatter.format(row.denominator)}</small></strong>
          </div>
        `).join("") || "<em>No opened sessions in this range yet.</em>"}
      </div>
      ${footnote ? `<p class="cohort-empty">${escapeHtml(footnote)}</p>` : ""}
    </article>
  `;
}

function renderBreakdown(
  title: string,
  description: string,
  items: StatsBreakdownItem[],
  kind: string,
  footnote = "",
): string {
  const maximum = Math.max(1, ...items.map((item) => item.value));
  return `
    <article class="stats-panel breakdown-panel kind-${kind}">
      <header class="panel-heading">
        <div><span class="panel-kicker">${escapeHtml(description)}</span><h2>${escapeHtml(title)}</h2></div>
        <strong>${integerFormatter.format(items.reduce((sum, item) => sum + item.value, 0))}</strong>
      </header>
      <div class="breakdown-list">
        ${items.slice(0, 7).map((item) => `
          <div>
            <span>${escapeHtml(humanize(item.label))}</span>
            <i><b style="width:${Math.max(2, item.value / maximum * 100)}%"></b></i>
            <strong>${integerFormatter.format(item.value)}</strong>
          </div>
        `).join("") || "<em>No events in this range yet.</em>"}
      </div>
      ${footnote ? `<p class="cohort-empty">${escapeHtml(footnote)}</p>` : ""}
    </article>
  `;
}

function bindChartInteraction(
  element: Element | null,
  points: ChartPoint[],
  series: ChartSeries[],
  stepMs: number,
): void {
  if (!(element instanceof HTMLElement) || points.length === 0) return;
  const tooltip = element.querySelector<HTMLElement>(".chart-tooltip");
  const guide = element.querySelector<HTMLElement>(".chart-guide");
  if (!tooltip || !guide) return;
  const move = (event: PointerEvent): void => {
    const rect = element.getBoundingClientRect();
    const ratioX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const index = Math.min(points.length - 1, Math.round(ratioX * (points.length - 1)));
    const point = points[index];
    const left = points.length <= 1 ? 50 : index / (points.length - 1) * 100;
    guide.style.left = `${left}%`;
    tooltip.style.left = `${left}%`;
    tooltip.innerHTML = `
      <time>${escapeHtml(formatTooltipTime(point.at, stepMs))}</time>
      ${series.map((item) => `<span><i style="--legend:${item.color}"></i>${item.label}<b>${integerFormatter.format(point.values[item.key] ?? 0)}</b></span>`).join("")}
    `;
    element.classList.add("hovering");
  };
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerenter", move);
  element.addEventListener("pointerleave", () => element.classList.remove("hovering"));
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let path = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const middle = (previous.x + current.x) / 2;
    path += ` C${middle.toFixed(2)} ${previous.y.toFixed(2)},${middle.toFixed(2)} ${current.y.toFixed(2)},${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
  }
  return path;
}

function axisLabelIndexes(length: number): number[] {
  if (length <= 1) return [0];
  return Array.from(new Set([0, Math.round((length - 1) / 4), Math.round((length - 1) / 2), Math.round((length - 1) * 3 / 4), length - 1]));
}

function niceMaximum(maximum: number): number {
  if (maximum <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  return Math.ceil(maximum / magnitude * 2) / 2 * magnitude;
}

function renderSkeleton(): string {
  return `
    <section class="stats-kpis skeleton-kpis">
      ${Array.from({ length: 6 }, () => '<div class="stats-skeleton kpi-skeleton"></div>').join("")}
    </section>
    <section class="stats-wide-grid skeleton-wide">
      <div class="stats-skeleton chart-skeleton"></div>
      <div class="stats-skeleton chart-skeleton"></div>
    </section>
    <section class="stats-breakdown-grid skeleton-grid">
      ${Array.from({ length: 6 }, () => '<div class="stats-skeleton breakdown-skeleton"></div>').join("")}
    </section>
  `;
}

function formatChartTime(at: number, stepMs: number): string {
  const date = new Date(at);
  if (stepMs < DAY_MS) return date.toLocaleTimeString([], { hour: "numeric" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/*
 * The hour is only meaningful where a point covers less than a day. A point
 * that covers a whole UTC day is named as that day: a local time on it would
 * put it in the wrong one for most of the world.
 */
function formatTooltipTime(at: number, stepMs: number): string {
  if (stepMs >= DAY_MS) return `${formatDay(at, "long")} UTC`;
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

function isClientStatsRange(value: string | undefined): value is StatsRange {
  return STATS_RANGES.includes(value as StatsRange);
}

function setMeta(name: string, content: string): void {
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.setAttribute("content", content);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function requiredStatsElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
