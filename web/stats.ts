import {
  STATS_RANGES,
  type StatsBreakdownItem,
  type StatsRange,
  type StatsSeriesPoint,
  type StatsSnapshot,
} from "../shared/stats";
import { RELEASE_CHECKSUMS_PATH, RELEASE_VERSION } from "../shared/release";
import "./stats.css";

type SeriesKey = "sessions" | "shares" | "collaborations" | "pageViews";

interface ChartSeries {
  key: SeriesKey;
  label: string;
  color: string;
}

const ACTIVITY_SERIES: ChartSeries[] = [
  { key: "sessions", label: "Created", color: "#8eafff" },
  { key: "shares", label: "Shared", color: "#75dac2" },
  { key: "collaborations", label: "Collaborated", color: "#d7a6ff" },
];
const TRAFFIC_SERIES: ChartSeries[] = [
  { key: "pageViews", label: "Page views", color: "#9ab7e8" },
];
const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
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
        <span>Counts only. No commands, terminal contents, IPs, session IDs, or user profiles.</span>
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
      if (snapshot.version !== 1) throw new Error("Unsupported statistics response");
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
  const rangeLabel = snapshot.range === "all" ? "all time" : `last ${snapshot.range}`;
  const outcomes = snapshot.breakdowns.outcomes;
  const endedSessions = outcomes.reduce((sum, item) => sum + item.value, 0);
  container.innerHTML = `
    <section class="stats-kpis" aria-label="Headline statistics">
      ${renderKpi(
        "Active now",
        metrics.activeSessions,
        `${integerFormatter.format(metrics.activeViewers)} viewer${metrics.activeViewers === 1 ? "" : "s"} connected now`,
        snapshot.trend,
        "sessions",
        "blue",
      )}
      ${renderKpi(
        "Sessions created",
        metrics.sessionsCreated,
        metrics.sessionsCreated === 0
          ? "None created in this range"
          : `${formatPercent(snapshot.rates.started)} reached the process`,
        snapshot.trend,
        "sessions",
        "violet",
      )}
      ${renderKpi(
        "Viewer connections",
        metrics.viewerConnections,
        `${integerFormatter.format(metrics.sharesOpened)} newly shared terminal${metrics.sharesOpened === 1 ? "" : "s"}`,
        snapshot.trend,
        "shares",
        "green",
      )}
      ${renderKpi(
        "Collaborations",
        metrics.collaborations,
        metrics.sessionsCreated === 0
          ? "No new-session cohort yet"
          : `${formatPercent(snapshot.rates.collaborated)} of created sessions`,
        snapshot.trend,
        "collaborations",
        "pink",
      )}
      ${renderKpi(
        "Terminal opens",
        metrics.terminalViews,
        `${integerFormatter.format(metrics.landingViews)} landing views`,
        snapshot.trend,
        "pageViews",
        "silver",
      )}
      ${renderKpi(
        "Average lifetime",
        formatDuration(metrics.averageDurationSeconds),
        `Longest ${formatDuration(metrics.longestDurationSeconds)}`,
        snapshot.trend,
        "sessions",
        "amber",
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
        ${renderTimeChart("activity", snapshot.trend, ACTIVITY_SERIES, snapshot.range)}
      </article>

      <article class="stats-panel funnel-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">New-session cohort</span><h2>From command to collaboration</h2></div>
          <span class="panel-range">${escapeHtml(rangeLabel)}</span>
        </header>
        ${renderFunnel(snapshot)}
      </article>
    </section>

    <section class="stats-middle-grid">
      <article class="stats-panel traffic-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">Attention</span><h2>Traffic pulse</h2></div>
          <strong>${integerFormatter.format(metrics.landingViews + metrics.terminalViews)} <small>views</small></strong>
        </header>
        ${renderTimeChart("traffic", snapshot.trend, TRAFFIC_SERIES, snapshot.range, true)}
        <div class="traffic-split">
          <span><i></i>Landing <b>${integerFormatter.format(metrics.landingViews)}</b></span>
          <span><i></i>Shared terminals <b>${integerFormatter.format(metrics.terminalViews)}</b></span>
        </div>
      </article>

      <article class="stats-panel outcomes-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">Reliability</span><h2>Session outcomes</h2></div>
          <strong>${integerFormatter.format(endedSessions)} <small>ended</small></strong>
        </header>
        ${renderDonut(outcomes)}
        <div class="quality-strip">
          <span><small>Avg peak audience</small><b>${numberFormatter.format(metrics.averagePeakViewers)}</b></span>
          <span><small>Largest audience</small><b>${integerFormatter.format(metrics.maximumPeakViewers)}</b></span>
        </div>
      </article>
    </section>

    <section class="stats-breakdown-grid">
      ${renderBreakdown("Acquisition", "Where landing visits came from", snapshot.breakdowns.referrers, "referrer")}
      ${renderBreakdown("Devices", "Browsers opening shell.online", snapshot.breakdowns.devices, "device")}
      ${renderBreakdown("CLI clients", "Versions creating sessions", snapshot.breakdowns.clients, "client")}
      ${renderBreakdown("Copy actions", "Commands and links copied", snapshot.breakdowns.copies, "copy")}
      ${renderBreakdown("Delivery requests", "Install script, skill, and binary requests", snapshot.breakdowns.downloads, "download")}
      <article class="stats-panel metric-summary-panel">
        <header class="panel-heading">
          <div><span class="panel-kicker">Distribution</span><h2>Delivery totals</h2></div>
        </header>
        <div class="metric-summary-list">
          <span><small>Install script requests</small><b>${integerFormatter.format(metrics.installs)}</b></span>
          <span><small>Agent skill</small><b>${integerFormatter.format(metrics.skillDownloads)}</b></span>
          <span><small>Release binaries</small><b>${integerFormatter.format(metrics.binaryDownloads)}</b></span>
          <span><small>All copies</small><b>${integerFormatter.format(metrics.copies)}</b></span>
        </div>
      </article>
    </section>

    <details class="stats-panel raw-metrics">
      <summary><span><small>Complete event ledger</small>Every tracked aggregate</span><i></i></summary>
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
      <span>Showing ${escapeHtml(rangeLabel)}.</span>
      <span>${snapshot.collectingSince ? `Collecting exact dashboard metrics since ${formatDate(snapshot.collectingSince)}.` : "Waiting for the first event."}</span>
    </div>
  `;

  bindChartInteraction(container.querySelector("#activity-chart"), snapshot.trend, ACTIVITY_SERIES);
  bindChartInteraction(container.querySelector("#traffic-chart"), snapshot.trend, TRAFFIC_SERIES);
}

function renderKpi(
  label: string,
  value: number | string,
  detail: string,
  trend: StatsSeriesPoint[],
  key: SeriesKey,
  tone: string,
): string {
  return `
    <article class="kpi-card tone-${tone}">
      <div><span>${escapeHtml(label)}</span><strong>${typeof value === "number" ? integerFormatter.format(value) : escapeHtml(value)}</strong></div>
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

function renderTimeChart(
  id: string,
  points: StatsSeriesPoint[],
  series: ChartSeries[],
  range: StatsRange,
  compact = false,
): string {
  const width = 760;
  const height = compact ? 150 : 250;
  const top = 16;
  const bottom = compact ? 24 : 32;
  const usableHeight = height - top - bottom;
  const maximum = Math.max(1, ...points.flatMap((point) => series.map((item) => point[item.key])));
  const roundedMaximum = niceMaximum(maximum);
  const paths = series.map((item, index) => {
    const coordinates = points.map((point, pointIndex) => ({
      x: points.length <= 1 ? width / 2 : pointIndex * width / (points.length - 1),
      y: top + usableHeight - point[item.key] / roundedMaximum * usableHeight,
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
    return `<text x="${x}" y="${height - 3}" text-anchor="${index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}">${point ? escapeHtml(formatChartTime(point.at, range)) : ""}</text>`;
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

function renderFunnel(snapshot: StatsSnapshot): string {
  const values = [
    { label: "Created", value: snapshot.metrics.sessionsCreated, color: "#8eafff" },
    { label: "Started", value: snapshot.metrics.sessionsStarted, color: "#819de5" },
    { label: "First opened", value: snapshot.metrics.sharesOpened, color: "#75dac2" },
    { label: "Collaborated", value: snapshot.metrics.collaborations, color: "#d7a6ff" },
  ];
  const maximum = Math.max(1, values[0].value, ...values.map((item) => item.value));
  return `
    <div class="funnel-chart">
      ${values.map((item, index) => {
        const width = item.value === 0 ? 2 : Math.max(7, item.value / maximum * 100);
        const previous = index === 0 ? item.value : values[index - 1].value;
        return `
          <div class="funnel-row">
            <span>${item.label}</span>
            <div><i style="width:${width}%;--funnel:${item.color}"></i></div>
            <b>${integerFormatter.format(item.value)}</b>
            <small>${index === 0 ? "baseline" : `${formatPercent(ratio(item.value, previous))} step`}</small>
          </div>
        `;
      }).join("")}
    </div>
  `;
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

function renderBreakdown(
  title: string,
  description: string,
  items: StatsBreakdownItem[],
  kind: string,
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
    </article>
  `;
}

function bindChartInteraction(
  element: Element | null,
  points: StatsSeriesPoint[],
  series: ChartSeries[],
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
      <time>${escapeHtml(formatTooltipTime(point.at))}</time>
      ${series.map((item) => `<span><i style="--legend:${item.color}"></i>${item.label}<b>${integerFormatter.format(point[item.key])}</b></span>`).join("")}
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

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${numberFormatter.format(seconds / 3_600)}h`;
  return `${numberFormatter.format(seconds / 86_400)}d`;
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatChartTime(at: number, range: StatsRange): string {
  const date = new Date(at);
  if (range === "24h") return date.toLocaleTimeString([], { hour: "numeric" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatTooltipTime(at: number): string {
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

function humanize(value: string): string {
  const aliases: Record<string, string> = {
    cli: "CLI",
    web: "Web",
    direct: "Direct",
    internal: "Internal",
    hacker_news: "Hacker News",
    task_exit: "Task exited",
    disconnected_timeout: "Disconnected timeout",
    never_started: "Never started",
    remote_input: "Remote input",
    darwin_arm64: "macOS arm64",
    darwin_amd64: "macOS amd64",
    linux_arm64: "Linux arm64",
    linux_amd64: "Linux amd64",
  };
  const normalized = value.replace(/-/g, "_");
  if (aliases[normalized]) return aliases[normalized];
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.min(1, numerator / denominator);
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
