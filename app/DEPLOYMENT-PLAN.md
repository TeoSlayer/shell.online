# Deployment plan

What is built, what is left, and what it costs. Written against the live
resources rather than from memory: every value below was read back from the
thing itself.

`DEPLOYMENT.md` explains *how* the service works. This is the plan for putting
it somewhere.

## Where it runs

The application is a Cloudflare Worker. Only the database is on Google Cloud,
because a managed Postgres is the one piece Cloudflare does not provide.

| | |
|---|---|
| Worker | `shell-online-app`, account `ef9da13de5572ea8482b2921770fa0e3` |
| Public host | `app.shell.online`, a custom domain on the `shell.online` zone |
| Client | Served from the Worker's `ASSETS` binding out of `app/dist` |
| Relay | A separate Worker on `shell.online`, deployed from its own config |
| Database | Cloud SQL for PostgreSQL 16, instance `shell-online-db` |
| Google project | `vulture-vision-cloud`, region `us-central1` |
| Application database | `shell_online`, owned by role `shell_app` |

**Why not `shell-online-auth`.** That project exists and would be the natural
home for the database, but it has no billing account attached and linking one
needs a permission this account does not have. Moving later is an export, a
Hyperdrive reconfiguration and nothing else; no code knows which project it is
in.

## How the Worker reaches the database

Cloud SQL speaks Postgres on a TCP port. A Worker has no VPC of its own, so
there are four hops and each one exists for a reason:

```
Worker  ->  Hyperdrive  ->  Workers VPC service  ->  Cloudflare Tunnel  ->  Cloud SQL
```

| Hop | Identifier | What it is for |
|---|---|---|
| Hyperdrive | `c51f052c29fb43b58a0aa57b66cb62f6` | Pools connections at the edge. Every isolate would otherwise open its own, and there are 25 in total to go round. |
| VPC service | `shell-online-db`, `01a08046-84e0-78c0-a8e9-558710df755a` | Gives the Worker a TCP target it is allowed to dial. `TCP:5432` to `34.135.154.179`. |
| Tunnel | `SHELL_ONLINE_DB`, `7ba18051-41a7-4a43-85c8-d4da61e7d025` | Carries that TCP to a machine inside Google Cloud. Outbound only, so nothing is opened to the internet to make it work. |
| Connector | VM `shell-online-db-connector`, `e2-micro`, `us-central1-a` | Runs `cloudflared`. Its address `34.41.2.41` is the **only** authorized network on the instance. |

The last row is the security property worth keeping: `authorizedNetworks` on
`shell-online-db` is exactly `34.41.2.41/32`. Whatever happens to the database
password, the only host on the internet that may open a socket to it is one
`e2-micro` whose sole job is to terminate a tunnel.

**The connector VM should be treated as part of the database.** It is not a
place to run anything else, it needs its patches, and if it stops, the app
stops. There is no second one. That is the honest cost of not having a VPC
connector between Workers and Google Cloud.

**Certificate verification on the last hop is disabled.** Hyperdrive requires
TLS to the origin, and Cloud SQL's certificate is issued for the instance name
rather than for the address the tunnel presents, so verification cannot
succeed as configured. The traffic is encrypted; it is not authenticated
against a name. It runs inside a tunnel that only that one VM can enter, which
is why this is tolerable, but it is a real gap and it should be closed by
uploading the instance CA once Hyperdrive supports attaching one to a VPC
service.

## Resource sizing, and the number that matters

**Cloud SQL `db-f1-micro`, 10 GB SSD.** Shared vCPU, 0.6 GB RAM. Right for the
current load and for a long time after: the whole dataset today is 8 MB.

**`max_connections` is 25 on this tier**, and Postgres counts them per server.
Hyperdrive is what makes that survivable: the Worker opens isolates freely and
Hyperdrive holds the actual connections, capped by `origin_connection_limit`.
Keep this true:

```
origin_connection_limit  <=  max_connections - 5
```

It is set to 20. It was created at the default of 60, which is above the
ceiling the server can actually honour, and would have surfaced as a burst of
`too many connections` under load rather than as anything gradual. Raising the
tier is the way to raise the limit.

The pool inside the process is capped at 5 as well, `DATABASE_POOL_MAX`. That
one matters for `npm run db:migrate` and the Node build, not for the Worker.

**Polling is the load.** Every linked machine that allowed browser-started
sessions polls every two seconds, roughly 43,000 requests per machine per day.
On Workers that is a bill rather than a capacity problem, and it is the reason
to move to long polling before the machine count grows. It is not a
correctness problem.

### What it costs, roughly

| | Monthly |
|---|---|
| Workers paid plan, including Hyperdrive | $5 |
| Cloud SQL `db-f1-micro` | about $9 |
| 10 GB SSD plus 7 daily backups | about $3 |
| Connector VM `e2-micro` plus its static address | about $10 |
| **Total** | **about $27** |

The database is the part that grows. Audit events are the only table with an
unbounded write rate, one row per committed input.

## Secrets

`MAIL_API_KEY` is the only secret the Worker holds. Set it once:

```sh
npx wrangler secret put MAIL_API_KEY --config wrangler.jsonc
```

The database credentials are **not** the Worker's. They belong to the
Hyperdrive configuration, which was given the connection string at creation
and hands the Worker back only `env.HYPERDRIVE.connectionString`, local to the
isolate. Nothing in the repository has ever held them.

For CI, the same values live in GitHub Actions secrets, and `DATABASE_URL`
there is used only by the migration step over the Cloud SQL Auth Proxy.

## The deploy

Two things happen in order, and the order is the whole point:

```sh
npm run build                                   # the client, into ./dist
DATABASE_URL=... npm run db:migrate              # schema first
npx wrangler deploy --config wrangler.jsonc      # then the Worker
```

Migrations only ever add, so a Worker from before a migration still runs
against the newer schema. That is what makes this order safe and a rollback
safe with it.

`.github/workflows/deploy-app.yml` does exactly these three steps on a push to
`main` that touches `app/`, authenticating to Google by Workload Identity
Federation so there is no service account key anywhere, and finishing with a
health and readiness check against `app.shell.online`.

`TRUST_PROXY` is not set and must not be. It is correct only behind a proxy
that rewrites `X-Forwarded-For`; the Worker reads the client address from
Cloudflare directly. Setting it would let a caller pick a new address per
request and walk past the rate limiter.

## The public surface

`workers_dev` and `preview_urls` are both `false`. A second public hostname is
a second way in to an app holding a database, and preview URLs are worse: they
would put every deployed version on its own permanent public address, each one
carrying the same Hyperdrive binding. `app.shell.online` is the only address.

This is also why the CLI has a single production host compiled into it.
`shell login` and the links it prints both resolve to `https://app.shell.online`.

## Rollback

```sh
npx wrangler rollback --config wrangler.jsonc
```

Migrations only ever add, and each is checksummed, so the previous version
meets a schema it still understands. There is no down migration and there
should not be one.

## Still to do before real users

- **Close the certificate-verification gap** on the Hyperdrive to Cloud SQL
  hop.
- **A dedicated Firebase project.** The client authenticates against one
  borrowed from elsewhere in the organization, which means a shared user pool
  and password-reset mail signed by another team. It is a build argument and a
  `FIREBASE_PROJECT_ID`; no code changes.
- **The audit log stores input in plaintext**, readable and exportable by the
  whole organization. Deliberate, stated in the terms, and worth deciding on
  explicitly rather than discovering.
- **Rotate the SendGrid key.** It has been through a terminal and a transcript.
- **The connector VM is a single point of failure.** Acceptable now, worth a
  second one behind the same tunnel before this carries anything that matters.
