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
- GPC, DNT, an existing analytics decline and Google's disable flag suppress
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

## Privacy and operation

No autocapture, remote JavaScript, replay, DOM text, raw errors, commands,
terminal output, URLs with identifiers, queries/fragments, referrers, names,
email addresses, IP forwarding or person profiles. Properties are constructed
from finite lists rather than redacted after collection. PostHog geo enrichment
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
