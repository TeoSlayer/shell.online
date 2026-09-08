# Deployment checklist

State as of 8 September 2026. Everything ticked was verified against the live
resource, not assumed.

## Done

- [x] **Cloud SQL instance** `shell-online-db`, PostgreSQL 16, `db-f1-micro`,
      10 GB SSD, `us-central1`, daily backups at 03:00 retained 7 days,
      maintenance Sunday 04:00, encrypted connections only, **no authorized
      networks** so it is unreachable from the internet.
- [x] **Database and role** `shell_online` owned by `shell_app`, password
      generated and never written to a tracked file.
- [x] **Migrations applied**: `001_initial`, `002_machine_id`,
      `003_harnesses`, all three with recorded checksums. 12 tables.
- [x] **Storage tested**: the store conformance suite, 45 cases, run against
      Cloud SQL itself rather than a local Postgres. All pass.
- [x] **Data migrated**: 79 records from the file store, both organizations
      intact, verified by reading the row counts back.
- [x] **Connection pool bounded.** `max_connections` is 25 on this tier and
      node-postgres defaults to 10 per process, so a third instance would have
      been refused a connection. Capped at 5, `DATABASE_POOL_MAX`.
- [x] **Secrets in Secret Manager**: `shell-online-database-url`,
      `shell-online-sendgrid-key`. Neither is in the image or the service
      definition.
- [x] **Container built** by Cloud Build, pushed to Artifact Registry.
- [x] **Cloud Run deployed**, reaching the database over the Cloud SQL
      connector on a unix socket. Health, readiness, the client and the guarded
      API all answer correctly.
- [x] **Email tracking disabled** per message, so the link in an invitation
      goes where the body says it goes.
- [x] **CI green** on every check, including CodeQL and all seven QEMU
      architectures.

## Yours to do

- [ ] **Cloudflare record for `app.shell.online`.** See below. Nothing else on
      this list matters as much: invitations currently link to a host that does
      not resolve, which is why they land in spam.
- [ ] **`WEB_ORIGIN`** updated to that host once it exists. It is currently the
      `run.app` URL, which works but is not what you want in mail.
- [ ] **`WEB_APP_URL`** in `web/main.ts` updated to match, then redeploy the
      relay so the landing page links to a real sign-up page.
- [ ] **SendGrid domain authentication for `shell.online`**, then
      `MAIL_FROM=shell.online <no-reply@shell.online>`. Until then the From
      address must stay on `@pilotprotocol.network`, which is the only
      authenticated domain.
- [ ] **A dedicated Firebase project.** The client authenticates against one
      borrowed from elsewhere in the organization, which means a shared user
      pool and password-reset mail signed by another team.
- [ ] **Rotate the SendGrid key.** It has been through a terminal and a
      transcript.
- [ ] **Deploy the relay** with your own Wrangler config.
- [ ] **Decide on the audit log.** Every prompt and command is stored in
      plaintext and is readable and exportable by the whole organization. It is
      in the terms; it should be a decision, not a discovery.

## The Cloudflare record

On the **shell.online** zone:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| `CNAME` | `app` | `ghs.googlehosted.com` | **DNS only (grey cloud)** |

Grey cloud matters. Cloud Run issues and serves its own certificate for a
mapped domain, which needs the name to resolve to Google while that happens.
Behind the orange cloud, Cloudflare terminates TLS and the mapping never
validates. You can move it behind the proxy afterwards on Full (Strict).

Create the mapping first, so Google is expecting the name:

```sh
gcloud beta run domain-mappings create \
  --project=vulture-vision-cloud --region=us-central1 \
  --service=shell-online-app --domain=app.shell.online
```

That command prints the records it wants. If it differs from the row above,
believe the command: mappings are regional and the target can vary.

**It will ask you to verify the domain** in Google Search Console first, since
`shell.online` is not yet verified to this account. If that turns into a fight,
the `run.app` URL is a perfectly good `WEB_ORIGIN` for a first deployment, and
everything except the address in the invitation works identically.

## Rollback

Cloud Run keeps revisions. To go back:

```sh
gcloud run services update-traffic shell-online-app \
  --project=vulture-vision-cloud --region=us-central1 \
  --to-revisions=<previous-revision>=100
```

Migrations only ever add, and each is checksummed, so the previous image meets
a schema it still understands. There is no down migration and there should not
be one.
