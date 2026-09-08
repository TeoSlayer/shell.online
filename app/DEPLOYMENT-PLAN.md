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
| Worker | `shell-online-app` |
| Public host | `app.shell.online`, a custom domain on the `shell.online` zone |
| Client | Served from the Worker's `ASSETS` binding out of `app/dist` |
| Relay | A separate Worker on `shell.online`, deployed from its own config |
| Database | Cloud SQL for PostgreSQL 16, instance `shell-online-db` |
| Database provider | Cloud SQL, in the same production region as its connector |
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
| Hyperdrive | Configured out of band | Pools connections at the edge. Every isolate would otherwise open its own. |
| VPC service | Configured out of band | Gives the Worker a TCP target it is allowed to dial. |
| Tunnel | Configured out of band | Carries that TCP to a machine inside the database network. Outbound only. |
| Connector | Dedicated VM | Runs `cloudflared` and is the only source allowed by the database network policy. |

The last row is the security property worth keeping: whatever happens to the
database password, the only allowed source is the dedicated connector whose
sole job is to terminate the tunnel.

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

The database grows with linked machines, sessions, comments, and explicit
collaboration events. Terminal input does not create database rows.

## Secrets

`MAIL_API_KEY` is the only secret the Worker holds. Set it once:

```sh
npx wrangler secret put MAIL_API_KEY --config wrangler.deploy.jsonc
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
npm run build                                      # client, into ./dist
DATABASE_URL=... npm run db:migrate                 # schema first
npm run render:deploy-config                        # local, ignored config
npx wrangler deploy --config wrangler.deploy.jsonc  # then the Worker
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
npx wrangler rollback --config wrangler.deploy.jsonc
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
- **Verify the input-privacy migration.** Terminal input is no longer sent to
  the accounts service, and its housekeeping sweep removes rows created by
  prerelease builds.
- **Rotate the SendGrid key.** It has been through a terminal and a transcript.
- **The connector VM is a single point of failure.** Acceptable now, worth a
  second one behind the same tunnel before this carries anything that matters.
