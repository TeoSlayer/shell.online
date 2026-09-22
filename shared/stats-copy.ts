import type { StatsAccountStats, StatsSnapshot } from "./stats";
import { DAY_MS } from "./stats-snapshot";

/*
 * The words on the statistics dashboard that are computed from its numbers:
 * the sentence at the top of each panel, the chip beside a headline figure,
 * and the names and formats everything is shown in. No DOM in here, so the
 * copy can be tested as plainly as the figures it describes.
 */

export const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.min(1, numerator / denominator);
}

export function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${numberFormatter.format(seconds / 3_600)}h`;
  return `${numberFormatter.format(seconds / 86_400)}d`;
}

export function humanize(value: string): string {
  const aliases: Record<string, string> = {
    cli: "CLI",
    web: "Web",
    direct: "Direct",
    internal: "Internal",
    hacker_news: "Hacker News",
    task_exit: "Task exited",
    persistent_task_exit: "Persistent task exited",
    disconnected_timeout: "Disconnected timeout",
    never_started: "Never started",
    expired: "Expired",
    session_full: "Session was full",
    typed_into_read_only: "Typed into a read-only session",
    viewer_read_only: "Read-only",
    viewer_rejected: "Viewer turned away",
    input_denied: "Input refused",
    install_outcome: "Installer outcome",
    machine_linked: "Linked a machine",
    session_registered: "Registered a session",
    command_sent: "Sent a command to a machine",
    vault_created: "Created a vault",
    invite_created: "Sent an invite",
    invite_accepted: "Accepted an invite",
    feedback_sent: "Sent feedback",
    one_day: "One day only",
    two_days: "Two days",
    three_to_six_days: "Three to six days",
    seven_or_more_days: "Seven days or more",
    ok: "Installed",
    failed: "Failed, unspecified",
    unsupported_os: "Unsupported OS",
    unsupported_arch: "Unsupported architecture",
    no_home: "HOME not set",
    install_dir_relative: "Install directory not absolute",
    install_dir_colon: "Install directory has a colon",
    install_dir_create: "Could not create install directory",
    install_dir_unwritable: "Install directory not writable",
    temp_dir: "Could not create temp directory",
    temp_dir_unwritable: "Temp directory not writable",
    download_failed: "Download failed",
    no_downloader: "No curl or wget",
    manifest_html: "Manifest came back as HTML",
    manifest_missing: "No checksum in manifest",
    manifest_invalid: "Invalid checksum in manifest",
    no_sha_tool: "No sha256sum or shasum",
    checksum_mismatch: "Checksum mismatch",
    write_failed: "Could not write executable",
    remote_input: "Remote input",
    cta_click: "Call-to-action click",
    signup_nav: "Sign up free (nav)",
    signup_hero: "Sign up free (hero)",
    signup_team: "Manage a team",
    signup_footer: "Web app (footer)",
    not_found: "Not found (404)",
    unknown_path: "Unknown path (served the landing page)",
    landing: "Landing",
    docs: "Docs",
    docs_app: "Docs · Web app",
    docs_cli: "Docs · CLI",
    docs_platforms: "Docs · Platforms",
    docs_mobile: "Docs · Mobile",
    docs_refstream: "Docs · Refstream",
    docs_reliability: "Docs · Reliability",
    docs_security: "Docs · Security",
    docs_e2ee: "Docs · E2EE",
    docs_docker: "Docs · Docker",
    docs_self_hosting: "Docs · Self-hosting",
    session: "Shared terminal",
    installer_download: "Installer fetched",
    binary_download: "Binary downloaded",
    page_loaded: "Browser reported a page load",
    start_nav: "Get started (nav)",
    start_hero: "Start a session (hero)",
    start_footer: "Start a session (footer)",
    demo: "See a real session",
    share_opened: "Opened in a browser",
    viewer_connected: "Viewer connected",
    viewer_disconnected: "Viewer disconnected",
    collaboration_started: "Typed from a browser",
    session_created: "Session created",
    session_started: "Session started",
    session_ended: "Session ended",
    page_view: "Page view",
    skill_download: "Skill fetched",
    stats_view: "Dashboard view",
    posix: "Install script (POSIX)",
    powershell: "Install script (PowerShell)",
    darwin_arm64: "macOS arm64",
    darwin_amd64: "macOS amd64",
    linux_arm64: "Linux arm64",
    linux_amd64: "Linux amd64",
    bot: "Crawlers",
    desktop: "Desktop",
    mobile: "Phone",
    tablet: "Tablet",
    unknown: "Unknown",
    google: "Google",
    github: "GitHub",
    reddit: "Reddit",
    x: "X",
    app: "Web app",
    newsletter: "Newsletter or email",
    product_hunt: "Product Hunt",
    linkedin: "LinkedIn",
    youtube: "YouTube",
    discord: "Discord",
    slack: "Slack",
    mastodon: "Mastodon",
    bluesky: "Bluesky",
    podcast: "Podcast",
    other: "Other sites",
  };
  const normalized = value.replace(/-/g, "_");
  if (aliases[normalized]) return aliases[normalized];
  const platform = normalized.match(/^(darwin|windows|linux|freebsd|openbsd|netbsd|dragonfly|solaris)_([a-z0-9]+)$/);
  if (platform) {
    const names: Record<string, string> = { darwin: "macOS", windows: "Windows", linux: "Linux", freebsd: "FreeBSD", openbsd: "OpenBSD", netbsd: "NetBSD", dragonfly: "DragonFly", solaris: "Solaris" };
    return `${names[platform[1]]} ${platform[2]}`;
  }
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/** A session outcome as the end of a sentence that begins "the sessions that ended". */
export function outcomePhrase(outcome: string): string {
  const phrases: Record<string, string> = {
    task_exit: "did so because the task exited",
    persistent_task_exit: "did so because a persistent task exited",
    disconnected_timeout: "timed out after the host disconnected",
    never_started: "never started",
    expired: "expired",
  };
  return phrases[outcome] ?? `ended as “${humanize(outcome)}”`;
}

/*
 * One sentence per section, computed from the same figures the section
 * shows, so the reader gets the finding before the numbers. Each guards its
 * ratios: a range with no sessions says so instead of dividing by zero.
 */
export function funnelInsight(snapshot: StatsSnapshot): string {
  const figures = snapshot.figures;
  const people = snapshot.uniques;
  const parts: string[] = [];
  if (figures.siteViews === 0) {
    parts.push("No page views from browsers in this range.");
  } else {
    const visitors = people.configured ? ` from ${integerFormatter.format(people.surfaces.site.unique)} visitor${people.surfaces.site.unique === 1 ? "" : "s"}` : "";
    const crawlers = figures.crawlerViews === 0 ? "" : `, and ${integerFormatter.format(figures.crawlerViews)} by crawlers kept out`;
    parts.push(`${integerFormatter.format(figures.siteViews)} views by people${visitors}${crawlers}.`);
    if (figures.installCopies > 0) parts.push(`${integerFormatter.format(figures.installCopies)} copied an install command.`);
    const runs = figures.installerRuns;
    parts.push(`${integerFormatter.format(runs)} install-script ${runs === 1 ? "fetch" : "fetches"}, ${integerFormatter.format(figures.installs)} binary download${figures.installs === 1 ? "" : "s"}, ${integerFormatter.format(figures.installsReported)} reported successful install${figures.installsReported === 1 ? "" : "s"}. These are separate event counts, not a matched conversion rate.`);
  }
  if (figures.sessionsStarted === 0) {
    parts.push("No session started.");
  } else {
    const machines = people.configured ? ` on ${integerFormatter.format(people.surfaces.cli.unique)} machine${people.surfaces.cli.unique === 1 ? "" : "s"}` : "";
    if (figures.neverStarted > 0) parts.push(`${integerFormatter.format(figures.neverStarted)} more ${figures.neverStarted === 1 ? "was" : "were"} created but never connected.`);
    const opened = formatPercent(ratio(figures.sharesOpened, figures.sessionsStarted));
    const typed = figures.sharesOpened === 0 ? "" : `, and ${formatPercent(ratio(figures.collaborations, figures.sharesOpened))} of those were typed into`;
    parts.push(`${integerFormatter.format(figures.sessionsStarted)} session${figures.sessionsStarted === 1 ? "" : "s"} started${machines}; ${opened} were opened in a browser${typed}.`);
  }
  return parts.join(" ");
}

export function trafficInsight(snapshot: StatsSnapshot): string {
  const metrics = snapshot.metrics;
  const audiences = snapshot.audiences.views;
  const total = metrics.landingViews + metrics.docsViews;
  if (total === 0) return "No landing or documentation views in this range.";
  const parts = [`${formatPercent(ratio(audiences.crawlers, total))} of ${integerFormatter.format(total)} views were crawlers.`];
  const referrers = snapshot.breakdowns.referrers;
  const referred = referrers.reduce((sum, item) => sum + item.value, 0);
  if (referrers.length > 0 && referred > 0) {
    parts.push(`Top source of landing visits: ${humanize(referrers[0].label)} (${formatPercent(ratio(referrers[0].value, referred))}).`);
  }
  if (metrics.unknownPaths > 0) {
    parts.push(`${integerFormatter.format(metrics.unknownPaths)} request${metrics.unknownPaths === 1 ? "" : "s"} hit a path the site does not know and got the landing page.`);
  }
  return parts.join(" ");
}

export function sessionsInsight(snapshot: StatsSnapshot): string {
  const metrics = snapshot.metrics;
  const days = Math.max(1, (snapshot.generatedAt - snapshot.rangeStart) / DAY_MS);
  if (metrics.sessionsCreated === 0) return "No session was created in this range.";
  const perDay = metrics.sessionsStarted / days;
  const parts = [
    `${integerFormatter.format(metrics.sessionsCreated)} created, ${integerFormatter.format(metrics.sessionsStarted)} started (${formatPercent(ratio(metrics.sessionsStarted, metrics.sessionsCreated))}), about ${perDay >= 10 ? integerFormatter.format(perDay) : numberFormatter.format(perDay)} a day.`,
  ];
  const outcomes = snapshot.breakdowns.outcomes;
  const ended = outcomes.reduce((sum, item) => sum + item.value, 0);
  if (ended > 0 && outcomes.length > 0) {
    parts.push(`${formatPercent(ratio(outcomes[0].value, ended))} of the ${integerFormatter.format(ended)} that ended ${outcomePhrase(outcomes[0].label)}; a session lasted ${formatDuration(metrics.averageDurationSeconds)} on average.`);
  }
  if (metrics.sharesOpened > 0) {
    parts.push(`A link waited ${formatDuration(metrics.averageSecondsToOpen)} for its first open on average.`);
  }
  if (metrics.viewersRejected > 0) {
    parts.push(`${integerFormatter.format(metrics.viewersRejected)} viewer${metrics.viewersRejected === 1 ? " was" : "s were"} turned away by a full, expired or unknown session.`);
  }
  return parts.join(" ");
}

/**
 * The accounts panel in a sentence: how many there are, how the range moved
 * it, how many of them came back, and how many of our own were left out.
 * Written so a quiet range reads as quiet rather than as a broken figure.
 */
export function accountsInsight(accounts: StatsAccountStats, rangeLabel: string): string {
  const ours = accounts.excluded === 0
    ? ""
    : ` ${integerFormatter.format(accounts.excluded)} of our own account${accounts.excluded === 1 ? " is" : "s are"} left out of every figure here.`;
  if (accounts.total === 0) {
    return `Nobody has signed up yet.${ours}`;
  }
  /* Over all time every account is new and nobody can have come back, so neither is said. */
  const allTime = accounts.newInRange === accounts.total && accounts.previous === null;
  const parts = [
    allTime
      ? `${integerFormatter.format(accounts.total)} account${accounts.total === 1 ? "" : "s"} in all.`
      : `${integerFormatter.format(accounts.total)} account${accounts.total === 1 ? "" : "s"}, ${accounts.newInRange === 0 ? `none of them new in ${rangeLabel}` : `${integerFormatter.format(accounts.newInRange)} of them from ${rangeLabel}`}.`,
  ];
  parts.push(accounts.activeInRange === 0
    ? `None of them opened the app in ${rangeLabel}.`
    : `${integerFormatter.format(accounts.activeInRange)} used the app (${formatPercent(ratio(accounts.activeInRange, accounts.total))} of all of them)${allTime ? "" : accounts.returningInRange === 0 ? ", all of them for the first time" : `, ${integerFormatter.format(accounts.returningInRange)} of which had signed up earlier`}.`);
  const previous = accounts.previous;
  if (previous !== null && previous.newAccounts > 0 && accounts.newInRange === 0) {
    parts.push(`The period before brought ${integerFormatter.format(previous.newAccounts)}; this one brought none.`);
  }
  return `${parts.join(" ")}${ours}`;
}

export interface DeltaChip {
  tone: "up" | "down" | "flat";
  text: string;
  /** The figure it moved from, for the chip's tooltip. */
  title: string;
}

/**
 * How a headline figure moved against the period before. A period with
 * nothing in it makes any change infinite, so it says "new" instead; a
 * change past tenfold is shown as a multiple; under half a percent is the
 * same. Null when there is nothing to compare with.
 */
export function deltaChip(current: number, before: number | null, priorLabel: string): DeltaChip | null {
  if (before === null || priorLabel === "") return null;
  const title = `${integerFormatter.format(before)} in ${priorLabel}`;
  if (before === 0 && current === 0) return { tone: "flat", text: "same", title };
  if (before === 0) return { tone: "up", text: "new", title };
  const change = (current - before) / before;
  if (Math.abs(change) < 0.005) return { tone: "flat", text: "same", title };
  const arrow = change > 0 ? "▲" : "▼";
  const text = Math.abs(change) >= 10
    ? `${arrow}${numberFormatter.format(current / before)}×`
    : `${arrow}${Math.round(Math.abs(change) * 100)}%`;
  return { tone: change > 0 ? "up" : "down", text, title };
}
