# Optional Jev assessments

Jev is an optional external-analysis layer, not an agent controller. Its labels
are advisory model inference: `needs_attention`, `possible_loop` and
`review_requested`. They never establish completion, overwrite an observed MCP
outcome, send terminal input, grant access or approve a deployment. Missing or
inconclusive evidence stays unknown.

## Current user experience and consent

In the game's **External analysis** panel, the signed-in owner must explicitly
enable external analysis, select an observed session and press **Request
assessment**. Consent is off by default and separate from MCP input permissions
and session-content sharing. A configured provider key alone does not authorize
an assessment. The server also checks that the caller owns the non-closed session.

The current UI sends only a bounded count of observed requests (`flows`). It does
not send terminal text, read or decrypt an excerpt, monitor sessions in the
background, or start assessments automatically. The selected session ID routes
the authenticated request; the integration sends the provider an allowlisted
state, not the roster or a terminal transcript. Counts alone cannot demonstrate
a blocker, repetitive reasoning or readiness for review; an unknown result is
expected when the evidence is insufficient.

The API accepts an optional explicitly supplied excerpt, but this is not wired
to a pane-disclosure UI. It is not automatic permission to collect pane text.
The integration clips excerpts to 600 characters and redacts credential-shaped
strings before dispatch. Redaction is best-effort minimization, not a guarantee
that arbitrary text contains no secrets. The service does not store the excerpt.

Disabling consent clears stored assessments. Consent and ownership are checked
again before dispatch and when saving a response, so a revoked request cannot
publish a new assessment. Revocation cannot retract data already sent to an
external provider. Read paths filter expired or no-longer-owned snapshots.

## Bounds and retention

| Bound | Current implementation |
|---|---|
| Shared per-owner budget | 6 assessment attempts and 8,000 outbound-state characters per sliding 60 seconds |
| One provider request | At most 2,000 state characters and 4 questions |
| Provider response | 2.5-second deadline; at most 65,536 response bytes |
| Local concurrency | One in-flight provider request per integration instance |
| Assessment lifetime | 120 seconds; at most 32 snapshots read per owner |
| Confidence | Advisory choice labels require at least 0.7 confidence |

The request/character budget is enforced in the shared store and fails closed
when unavailable. Attempts can consume budget even when the provider fails or
consent changes; these limits are not a currency or token-price guarantee. There
are no automatic provider retries. Assessment expiry is enforced on reads;
physical deletion can happen later during cleanup. Consent persists until changed.

## Deployment

The accounts API owns this integration. Both the Node entrypoint
(`app/server/index.ts`) and Cloudflare entrypoint (`app/worker/index.ts`) pass
`JEV_API_KEY` to the shared router as a server-only credential. Blank or absent
keys leave analysis unavailable. No key belongs in browser code, `VITE_*`
variables, checked-in Wrangler `vars`, screenshots or logs.

Apply migration `023_jev_assessments.sql`, together with earlier pending
migrations, before deploying these API routes. It creates the consent,
assessment and shared-budget tables. With `DATABASE_URL` supplied securely to
the migration process, run from the repository root:

```sh
npm --prefix app run db:migrate
npm --prefix app run db:verify
```

The Worker opens Postgres with migrations disabled; a cold start does not apply
the schema. The app deployment workflow performs the migration before deploying
unless explicitly skipped. Do not skip it on the first Jev deployment.

For Cloudflare, use the accounts/app deployment configuration rendered by
`npm --prefix app run render:deploy-config` from its usual non-secret deployment
settings. After checking the target account and Worker, set the optional secret
through Wrangler's interactive secret input:

```sh
npx wrangler secret put JEV_API_KEY --config app/wrangler.deploy.jsonc
```

This targets `shell-online-app`, not the static game Worker or relay. Keep the
secret out of the rendered configuration. For Node, supply `JEV_API_KEY` through
the server process's secret environment. A restart/redeploy picks up changed
configuration. Setting deployment configuration does not opt any user in.

## Verification boundary

Tests cover the entrypoint handoff, consent/access gates, revocation, bounds,
mock provider responses and the metadata-only UI. They do not establish a
successful authenticated request to the actual provider, production secret
configuration, provider quality or production database migration status. Live
provider verification and rollout require separate explicit authorization; no
such verification is claimed here.

The authenticated API surface is `GET /api/game/assessments`,
`PUT /api/game/assessments/consent` and
`POST /api/game/sessions/:id/assess`.
