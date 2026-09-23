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

- `$pageview` / `$pageleave`: route category and actual focused time (`active_ms`).
- `command_copy` / `landing_cta`: fixed button categories, never copied text.
- `app_action`: successful or failed mutations with a fixed target and HTTP method.
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

Instrumentation version `2` includes `capture_source=browser` or `server` on
every event. Browser events supply PostHog's `$user_agent` from the browser,
limited to 1,024 printable ASCII characters. No replacement browser string is
invented. `user_agent_status` is `present`, `missing` or `invalid`;
`browser_automation` reflects `navigator.webdriver` when available. A false
automation flag or a normal-looking user agent does not prove a human visit.
Server milestones do not copy incoming request headers or impersonate browsers.

For a report of likely non-automated browser traffic, filter to:

- `instrumentation_version = 2`
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
terminal output, URLs with identifiers, queries/fragments, referrers, names,
email addresses, IP forwarding or person profiles. Properties are constructed
from finite lists, except the bounded browser user-agent string, rather than
redacted after collection. PostHog geo enrichment
is disabled. Network requests necessarily reach its US ingestion service.

Anonymous identifiers use a Secure, SameSite=Lax, host-only session cookie, not
localStorage. An idle analytics session rotates after 30 minutes. Account changes
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
