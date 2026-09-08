# Deployment plan

What is already built, what is left, and what it costs. Written against the
live project rather than from memory: every value below was read back from the
resources themselves.

`DEPLOYMENT.md` explains *how* the service works. This is the plan for putting
it somewhere.

## Where it runs

| | |
|---|---|
| Google Cloud project | `vulture-vision-cloud` |
| Region | `us-central1` |
| Database | Cloud SQL for PostgreSQL 16, instance `shell-online-db` |
| Connection name | `vulture-vision-cloud:us-central1:shell-online-db` |
| Application database | `shell_online`, owned by role `shell_app` |
| Container image | `us-central1-docker.pkg.dev/vulture-vision-cloud/cloud-run-source-deploy/shell-online-app` |
| Service | Cloud Run, `shell-online-app` |
| Relay | Cloudflare Worker, deployed separately with your own Wrangler config |

**Why not `shell-online-auth`.** That project exists and would be the natural
home, but it has no billing account attached and linking one needs a
permission this account does not have. Moving later is a database export, a
rebuild and a redeploy; nothing in the code knows which project it is in.

## Resource sizing, and the two numbers that matter

**Cloud SQL `db-f1-micro`, 10 GB SSD.** Shared vCPU, 0.6 GB RAM. Right for the
current load and for a long time after: the whole dataset today is 8 MB.

**`max_connections` is 25 on this tier.** Postgres counts connections per
server, so that ceiling is shared by every running instance of the service.
node-postgres defaults to a pool of 10 per process, which means a third Cloud
Run instance would be refused a connection rather than made to wait. The pool
is therefore capped at 5, configurable with `DATABASE_POOL_MAX`. Keep this
true:

```
instances x DATABASE_POOL_MAX  <=  max_connections - 5
```

At the defaults that allows four instances. Raising either side of it means
raising the tier.

**The service will not scale to zero.** Every linked machine that allowed
browser-started sessions polls every two seconds, which is roughly 43,000
requests per machine per day and means there is never an idle minute once one
machine is linked. Set `--min-instances=1` deliberately rather than paying for
the same thing accidentally through cold starts, and size the CPU for polling
rather than for page loads.

Long polling would remove almost all of that traffic and is the obvious next
change if the machine count grows. It is not a correctness problem, only a
bill.

### What it costs, roughly

| | Monthly |
|---|---|
| Cloud SQL `db-f1-micro` | about $9 |
| 10 GB SSD plus 7 daily backups | about $3 |
| Cloud Run, 1 instance always warm, 512 MB | about $12 |
| Artifact Registry, Secret Manager, egress | under $2 |
| **Total** | **about $25** |

The database is the part that grows. Audit events are the only table with an
unbounded write rate, one row per committed input.

## Secrets

In Secret Manager, never in the image or the service definition:

| Secret | Holds |
|---|---|
| `shell-online-database-url` | The full connection string, including the password |
| `shell-online-sendgrid-key` | The SendGrid API key |

The Cloud Run service account needs `roles/secretmanager.secretAccessor` on
both, and `roles/cloudsql.client` on the project.

## The deploy

```sh
gcloud run deploy shell-online-app \
  --project=vulture-vision-cloud --region=us-central1 \
  --image=us-central1-docker.pkg.dev/vulture-vision-cloud/cloud-run-source-deploy/shell-online-app:v1 \
  --add-cloudsql-instances=vulture-vision-cloud:us-central1:shell-online-db \
  --set-secrets=DATABASE_URL=shell-online-database-url:latest,MAIL_API_KEY=shell-online-sendgrid-key:latest \
  --set-env-vars=NODE_ENV=production,FIREBASE_PROJECT_ID=...,WEB_ORIGIN=https://app.shell.online,RELAY_URL=https://shell.online,TRUST_PROXY=1,MAIL_PROVIDER=sendgrid,MAIL_FROM='shell.online <no-reply@pilotprotocol.network>' \
  --min-instances=1 --max-instances=4 --memory=512Mi --cpu=1 \
  --allow-unauthenticated
```

The database is reached over the Cloud SQL connector on a unix socket, not the
network. The instance has no authorized networks, so nothing can reach it from
the internet whatever happens to the password.

`TRUST_PROXY=1` is correct here and only here: Cloud Run does rewrite
`X-Forwarded-For`. Setting it anywhere without a proxy in front would let a
caller pick a new address per request and walk past the rate limiter.

## Custom domain

The web app has to answer on the host that invitation links point at, or the
mail goes to spam. See the checklist.

Cloud Run needs a domain mapping for a custom host. The mapping issues and
serves its own certificate, so the DNS record has to resolve to Google while
that happens: **add it DNS-only in Cloudflare**, not proxied. It can be moved
behind the proxy afterwards on Full (Strict).

Domain mapping also requires the domain to be verified to this account in
Search Console. If that turns into a fight, the `*.run.app` URL works
immediately and is a perfectly good `WEB_ORIGIN` for a first deployment.

## Still to do before real users

- **Firebase.** The client authenticates against a project borrowed from
  elsewhere in the organization, which means a shared user pool and
  password-reset mail signed by another team. A deployment needs its own
  project with Identity Platform enabled. It is a build argument and a
  `FIREBASE_PROJECT_ID`; nothing in the code changes.
- **The audit log stores input in plaintext**, readable and exportable by the
  whole organization. Deliberate, stated in the terms, and worth deciding on
  explicitly rather than discovering.
- **Rotate the SendGrid key** once testing is done. It has been through a
  terminal and a transcript.
- **The relay** is yours to deploy with your own Wrangler config.
