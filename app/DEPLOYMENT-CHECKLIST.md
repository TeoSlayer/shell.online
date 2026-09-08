# Deployment checklist

State as of 8 September 2026. Everything ticked was verified against the live
resource, not assumed.

## Done

- [x] **Cloud SQL instance** `shell-online-db`, PostgreSQL 16, `db-f1-micro`,
      10 GB SSD, `us-central1`, daily backups retained 7 days, encrypted
      connections only (`sslMode: ENCRYPTED_ONLY`).
- [x] **The database is not on the public internet.** Its network allowlist is
      limited to the dedicated connector, with no general ingress rule.
- [x] **Database and role** `shell_online` owned by `shell_app`, password
      generated and never written to a tracked file.
- [x] **Migrations applied**: `001_initial`, `002_machine_id`, `003_harnesses`,
      all three with recorded checksums. 12 tables.
- [x] **Storage tested**: the store conformance suite, 45 cases, run against
      Cloud SQL itself rather than a local Postgres. All pass.
- [x] **Data migrated**: 79 records from the file store, both organizations
      intact, verified by reading the row counts back.
- [x] **Dedicated connector** running `cloudflared`, with its tunnel healthy.
- [x] **Workers VPC service** `shell-online-db`, `TCP:5432` over that tunnel.
- [x] **Hyperdrive** pooling for the Worker, with its origin connection limit
      below the database server ceiling.
- [x] **Worker deployed** on `app.shell.online` as a custom domain. Health,
      readiness, the client and the guarded API all answer correctly, and
      `/api/ready` runs a real query the whole length of the chain.
- [x] **One public hostname.** `workers_dev` and `preview_urls` both `false`,
      so no deployed version gets its own permanent public address.
- [x] **Firebase authorized domains** include `app.shell.online`.
- [x] **CLI points at one real host.** `shell login` and the links it prints
      both resolve to `https://app.shell.online`; the old
      `accounts.shell.online`, which never resolved, is gone from the binary.
- [x] **Binaries built at 0.9.0**, 78 files verified, `shell login` and the
      daemon compiled in.
- [x] **Email tracking disabled** per message, so the link in an invitation
      goes where the body says it goes.
- [x] **Deploy workflow written**: migrate, then deploy, then health check,
      with Workload Identity Federation rather than a service account key.
- [x] **CI green** on every check, including CodeQL and all seven QEMU
      architectures.

## Yours to do

Two of these need permissions this account does not have; the rest are
decisions.

- [ ] **Provide `wrangler.production.jsonc` for the relay**, then
      `npm run deploy:production`. The binaries are the relay's static assets,
      so this is what publishes 0.9.0 at the existing install URL. Nothing
      else on this list is blocking a release.
- [ ] **Repository secrets**, for the deploy workflow to run on its own. Needs
      admin on the repository, which this account does not have:
      `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL`,
      `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`. Variables:
      `CLOUD_SQL_INSTANCE`, `WEB_ORIGIN`, `RELAY_URL`, and the five
      `VITE_FIREBASE_*` values.
- [ ] **Create the Workload Identity Federation pool.** Blocked on
      `roles/iam.workloadIdentityPoolAdmin` for `alex@vulturelabs.io`. Until
      it exists the workflow can deploy but cannot migrate.
- [ ] **Tag `v0.9.0`**, then fill in the Homebrew checksum, which cannot be
      known until the tag exists:

      ```sh
      git tag v0.9.0 && git push origin v0.9.0
      curl -fsSL https://github.com/TeoSlayer/shell.online/archive/refs/tags/v0.9.0.tar.gz \
        | shasum -a 256
      ```

      Put that digest in `Formula/shell-online.rb` in place of the
      placeholder. `npm test` refuses a placeholder on a tag build and
      refuses a formula whose version has drifted from `package.json`, so
      forgetting this fails CI rather than failing `brew install`.
- [ ] **SendGrid domain authentication for `shell.online`**, then
      `MAIL_FROM=shell.online <no-reply@shell.online>`. Until then the From
      address must stay on `@pilotprotocol.network`, the only authenticated
      domain.
- [ ] **A dedicated Firebase project.** The client authenticates against one
      borrowed from elsewhere in the organization: shared user pool,
      password-reset mail signed by another team.
- [ ] **Rotate the SendGrid key.** It has been through a terminal and a
      transcript.
- [ ] **Verify input privacy.** Confirm the browser does not call
      `POST /api/audit`, and confirm the first scheduled housekeeping sweep
      after upgrading removes legacy plaintext input rows.
- [ ] **Close the certificate-verification gap** between Hyperdrive and Cloud
      SQL. See `DEPLOYMENT-PLAN.md`.

## DNS

Nothing to add. `app.shell.online` is a Cloudflare **custom domain** on the
Worker, which means Cloudflare created the record and issues the certificate
itself. The earlier instruction to add a `CNAME` to `ghs.googlehosted.com` was
for Cloud Run and is wrong now; if that record still exists on the zone,
delete it.

The relay keeps `shell.online` itself. This is only the app subdomain.

## Rollback

```sh
npx wrangler rollback --config wrangler.deploy.jsonc
```

Migrations only ever add, and each is checksummed, so the previous version
meets a schema it still understands. There is no down migration and there
should not be one.
