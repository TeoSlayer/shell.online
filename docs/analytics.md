# Public website measurement

The landing page is a static HTML entry point with a small interaction bundle.
The terminal renderer is loaded only when a visitor opens a terminal or other
application route. Brand artwork is served locally.

## What the counters mean

| Signal | What it establishes |
| --- | --- |
| Page response | The Worker served a document request, excluding prefetches. It does not prove that the page rendered. |
| `page_loaded` | The eligible public page's JavaScript initialized and reported a load. Blocking scripts or analytics can prevent it. |
| `cta_click` | A particular landing button was clicked, not an account created. |
| `copy` | The clipboard API reported success for the install or run command, not that the command was executed. |
| `copy:docs_command` | A docs command was copied. Command text and search queries are not collected. |
| `cta_click:github_star` | The visitor opened the GitHub star prompt. It does not establish that they starred the project. |
| `installer_download` | An install script was fetched. |
| `binary_download` | A complete, non-range binary response was served. Repeated full downloads can count again. |
| `install_outcome:ok` | The installer reported success. This is not an independently verified installation. |
| Session created / started | Separate API-creation and host-connection lifecycle events. |

These are separate event totals. Do not divide unmatched ad clicks, downloads
and sessions and call the result a verified conversion rate. Repeat activity,
different reporting windows, bot classification and blocked telemetry affect
the totals. New browser-load events have no historical backfill.

The existing install-to-session cohort uses secret-salted address hashes. Shared
networks can merge machines; changing networks can split one machine. Its end
event is a session-creation request, not proof of a working session. It does not
connect a phone ad click to a later installation on another computer.

## Attribution and privacy boundaries

- Google Analytics is limited to the public `shell.online` landing and recognized
  documentation routes. Private terminals, account pages and stats pages do not
  load the tag. Unknown query parameters or unrecognized fragments disable it.
- Supported campaign links preserve finite source and medium buckets. X/Twitter,
  `t.co` referrals and the presence of `twclid` are recognized. Raw click IDs,
  campaign names, search terms and ad-content strings are not collected by our
  public events. Arbitrary campaign/ad-level reporting is therefore unavailable.
- GA receives a canonical page URL without query or fragment, an empty referrer
  and a fixed public title. Google Signals and ad-personalization signals are off.
  GA cookies are host-only, use the `shell_public_ga` prefix and expire after
  90 days. These are Google Analytics cookies, not cookie-free measurement.
- The first-party event endpoint accepts bounded bodies and fixed event/target/
  source values. It does not store submitted page URLs, terminal content, link
  passwords, frame keys or bearer tokens.
- GPC, DNT, an existing analytics decline, `shell_analytics_opt_out=1` and Google's disable flag suppress
  browser marketing events. GPC/DNT also suppress first-party visitor hashing.
  Aggregate operational request counts are separate and can still be recorded.
- Public event reports and installer reports can be spoofed; rate limits and
  bot classification reduce noise but are not proof of individual users.

## Local validation

Run `npm run check` and `npm run build:web`. For the real-browser layout and
interaction gate, start Vite on port 5178 and run
`node scripts/test-landing-browser.mjs`. `LANDING_TEST_URL` may point to another
loopback-only preview. The gate checks phone, tablet and desktop layouts,
locally served logos, touch targets, command selection, copy success/failure,
and the real screenshot switch. Local previews emit no marketing events.

Before deploying analytics changes, inspect actual Google collection requests
with collection intercepted rather than sent. Verify one page view, correct
source/medium, copy and CTA events, and no private URL fields. Mocked `dataLayer`
tests alone do not prove what Google's script transmits.

## X advertising pixel

The public pixel ID is `rfilf`. Only the eligible public landing page
initializes it, once per document. Documentation, account, vault, terminal, stats, local-preview,
unknown-query and private-fragment pages do not. GPC, DNT and saved analytics
opt-outs suppress initialization. A missing/blocked vendor script must not stop
the page from working.

Before `twq('config', 'rfilf')`, the integration sets `page_location` to the fixed
public URL `https://shell.online/` (also replacing any original referrer)
and disables automatic button capture, advanced matching, data-layer tracking
and dwell/page-leave tracking. The real vendor-script browser gate verifies
these switches: they are not a guarantee about future vendor script changes.
X receives its own advertising click/cookie identifiers and normal browser/
network metadata. Unlike our finite source buckets, it can receive a valid
`twclid`; its cookies may be shared across shell.online subdomains. We do not
provide emails, phones, account identifiers or terminal information.

This is **base-visit measurement**, not a claimed install/signup conversion.
Copying a command, downloading an installer, reporting installation success and
starting a session are different actions. Set up corresponding real events in
X Events Manager before wiring event-specific `tw-rfilf-…` IDs. No placeholder
event is sent, and there is no second `track PageView` on top of `config`.
Only the fixed landing URL is sent; no query strings or fragments. X's
auto-created Landing Page Views and Site Visits use the base pixel; no extra
conversion event ID or Conversion API token is needed for this scope.

The Conversion API is not enabled. Its token is a server secret, never a browser
variable, checked-in config, CLI argument, log field or public pixel setting.
Rotate any token exposed in chat. A future server integration requires an actual
event ID, a verified action, an intentionally collected matching identifier,
bounded retries and the same `conversion_id` on browser/server copies of one
action. Do not invent identifiers, send synthetic live conversions, or bypass
browser opt-outs through the server.

### Pixel verification

| Destination | Scope | What the gate checks |
| --- | --- | --- |
| GA4 `G-101HMD03VD` | Public landing/docs | One page view; canonical URL/referrer; copy and CTA separate from installs |
| X `rfilf` | Public landing only | One base event per collector; URL/form redaction; no automatic events; private-page and opt-out exclusions |
| PostHog US | Explicit public/app/viewer events | Real browser metadata; route templates; no replay/content; anonymous identity lifecycle |
| First-party statistics | Public actions and operational milestones | Fixed event/target/source; loads, copies, downloads and reported installs kept separate |

Run `node scripts/test-x-pixel-browser.mjs` and
`node scripts/test-posthog-browser.mjs` after building the site/app. Set
`X_PIXEL_LIVE=1` / `POSTHOG_LIVE=1` to exercise deployed assets. Collection is
intercepted in these gates: passing proves browser behavior, not ingestion into
an advertiser account. Verify received activity separately in X Events Manager,
GA4 Realtime and PostHog Live Events using one deliberate operator visit.
Ad blockers can suppress these services; do not proxy around them or label
missing events as confirmed bounces.

Vendor references: [X website tracking](https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites)
and [page-location controls](https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites/about-conversion-tracking).

## Platform product analytics (PostHog)

PostHog receives explicit, content-free events from the public site, docs,
account app, current game and shared-terminal viewer. GA4 remains limited to
the public landing and docs. Existing first-party statistics remain independent.

`shared/posthog.ts` is the fixed event/property allowlist and public ingestion
configuration. `web/posthog.ts` supplies the browser transport lifecycle. The
project token is a public capture token, not a personal/admin credential.

## What is measured

- `$pageview` / `$pageleave`: route category, per-view ID and native PostHog page
  duration fields. Native duration includes background time; it is not focused time.
- `page_engaged`: once per page view after ten seconds of actual visible, focused
  reading. It is not a timer heartbeat or proof of a human visitor.
- `page_engagement`: **incremental** focused milliseconds (`active_ms`), flushed
  on backgrounding and navigation. Sum this event alone for active time; do not
  also sum the cumulative `$pageleave.active_ms`. Mobile-close delivery is best effort.
- `command_copy` / `landing_cta`: fixed button categories, never copied text.
- `app_action`: successful or failed mutations with fixed target, action and HTTP
  method; failures distinguish network, malformed response, HTTP and signed-out.
  A successful `command_requested` means queue acceptance, not completed execution.
- `auth_attempt` / `auth_result`: email/Google authentication resolution without
  form values or raw errors. `account_created` requires identity-provider confirmation;
  an existing Google account signing in is not a new account. OIDC provider returns
  are represented by `signed_in`, not a claimed new-account event.
- `signed_in` / `signed_out`: identity transitions, without an account identifier.
- `terminal_connected` / `report_opened`: viewer connection and feedback entry.
- Relay milestones (installer/binary downloads, install outcomes, sessions and
  viewer connections) are mirrored when `POSTHOG_ENABLED=1`. These are aggregate
  counts with one fixed anonymous service identity, not users or an attributed
  end-to-end installation funnel. Filter `surface=relay` separately from browsers.

Use `surface` to separate landing, docs, terminal, app and game usage. A copy is
not an installation, an accepted send is not an agent completing work, and a
page load is not a verified human visit. Do not equate these stages in funnels.

### Browser and automation filters

Instrumentation versions `2` and `3` include `capture_source=browser` or `server` on
every event. Browser events supply PostHog's `$user_agent` from the browser,
limited to 1,024 printable ASCII characters. No replacement browser string is
invented. `user_agent_status` is `present`, `missing` or `invalid`;
`browser_automation` reflects `navigator.webdriver` when available. A false
automation flag or a normal-looking user agent does not prove a human visit.
Server milestones do not copy incoming request headers or impersonate browsers.

For a report of likely non-automated browser traffic, filter to:

- `instrumentation_version >= 2` (use `3` for repaired session/engagement reports)
- `capture_source = browser`
- `user_agent_status = present`
- `browser_automation = false`
- PostHog's **Is bot = false**

Keep separate views for known automation and unknown/missing metadata. Earlier
events omitted both user-agent properties, so PostHog may classify real visits
as `no_user_agent`. Do not delete or relabel that history as confirmed bots, and
do not apply the new filter to historical conversion comparisons without
accounting for the instrumentation change. Missing event metadata does not
establish that the original HTTP request lacked a User-Agent header.

Classification is best-effort, not an access-control rule. No firewall blocks,
challenges, user IP collection or fingerprinting are introduced by this fix.

## Privacy and operation

No autocapture, remote JavaScript, replay, DOM text, raw errors, commands,
terminal output, URLs with identifiers, queries/fragments, raw referrers, names,
email addresses, IP forwarding or person profiles. Properties are constructed
from finite lists, except the bounded browser user-agent string, rather than
redacted after collection. PostHog geo enrichment
is disabled. Network requests necessarily reach its US ingestion service.

Anonymous identifiers use a Secure, SameSite=Lax, host-only session cookie, not
localStorage. Version 3 uses UUIDv7 analytics session IDs, as required by PostHog,
and client capture timestamps. Version 1/2 used UUIDv4 IDs: pageviews arrived but
were excluded from native session aggregations. Old cookies are migrated in place;
historical events are not silently rewritten. Sessions rotate after 30 minutes of
inactivity or 24 hours total, including in long-lived tabs. Account changes
clear the app identifier; public-site and app identities are intentionally not
joined. GPC/DNT and saved opt-outs stop browser events. Unknown/self-hosted origins,
OAuth callbacks and the private statistics site send nothing. CSP permits only
the ingestion origin, not third-party scripts. Failed capture never blocks work.

For verification, intercept `/i/v0/e/` in browser tests and assert emitted payloads
contain no synthetic secret markers. Keep synthetic tests out of production
analytics. API acceptance proves ingestion accepted a request, not that a report
has finished processing it. A capture token cannot query dashboards.

Run `node scripts/test-posthog-browser.mjs` after building the site and app to
check actual outgoing requests, metadata, route templates, actions, SPA
navigation, duplicate prevention and privacy controls. Set `POSTHOG_LIVE=1`
to inspect deployed assets; collection remains intercepted so synthetic events
never enter the project. Safari/X-browser user-agent fixtures are emulated in
Chrome, not a claim of running those browsers themselves.

## Reports that answer different questions

Use the **shell.online — acquisition and product health** dashboard in PostHog:

| Report | Question |
| --- | --- |
| Tracking health | Which versions have valid session IDs and metadata? |
| Acquisition | Which finite sources, media, devices and surfaces bring browser sessions? |
| Landing actions | Do visitors read, copy install/run commands, or follow signup CTAs? |
| Pages and guides | Where is actual foreground time spent? |
| Account access | Are authentication attempts succeeding? How many accounts were confirmed created? |
| App actions | Which operations fail, and at which bounded failure category? |
| Product usage | Are app pages, viewers and the current game being used? |
| Install and relay milestones | How many downloads, reported installs, hosts and viewers reach each stage? |

Stage counts are not automatically an ordered funnel. Public-site/app identities
are deliberately separate and reset at account changes; neither is joined to
the aggregate relay identity. Cross-device advertising ROI and person-level
retention cannot be inferred from these counts. No replay/autocapture is enabled.

Recognized guides get separate paths such as `/docs/agents`. Public campaigns
use native `utm_source`/`utm_medium` properties after finite classification;
referrers become known domain buckets, never raw URLs. Browser/OS/device
families are derived locally. Unknown values stay unknown. Raw campaign names
and click IDs are not retained in GA4/PostHog.

### GA4 configuration and engagement verification

Keep GA4 on public landing/docs only; PostHog covers private app/viewer routes
with redacted templates. Configure enhanced measurement to keep page loads and
scrolls, but disable browser-history pageviews, outbound-click capture, site
search, form interactions, video and file-download autocapture. Explicit copy/
CTA events and first-party verified download responses already describe those
stages more accurately, without automatic URL/DOM collection.

Register the event-scoped **Action target** custom dimension for parameter
`target`, so GA4 explorations can distinguish install, run, docs and CTA buttons.
It contains finite labels, not button text or destination URLs. Custom dimensions
apply prospectively and can take time to appear in processed reports.

Do not mark page views or reading milestones as key events just to lower bounce.
GA4 engaged sessions are computed from its real engagement signal; the maintained
X/GA browser gate now verifies `_et >= 10000` and `seg=1` after a genuinely focused
visit. Headless pages without focus must not be mistaken for engagement failures.
Check **today** separately from historical reports; configuration changes cannot
repair prior missing metadata, and an all-traffic bounce figure alone does not
prove fraudulent ad clicks.

References: [PostHog custom session requirements](https://posthog.com/docs/data/sessions#custom-session-ids),
[GA4 engagement and bounce](https://support.google.com/analytics/answer/12195621),
[manual GA4 pageviews](https://developers.google.com/analytics/devguides/collection/ga4/views).
