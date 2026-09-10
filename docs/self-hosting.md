# Self-hosting

shell.online has two services:

- the relay, which serves the public site and carries encrypted terminal frames;
- the optional accounts app in `app/`.

The CLI does not need the accounts app.

## Relay on Cloudflare Workers

Requirements:

- Node.js 22 and npm;
- Go 1.26.8 if the deployment should serve downloadable binaries;
- a Cloudflare account with Workers, Durable Objects, Rate Limiting, and
  Analytics Engine available.

Create a local Wrangler configuration:

```sh
cp wrangler.example.jsonc wrangler.local.jsonc
npm ci
npm run build
npx wrangler deploy --config wrangler.local.jsonc
```

`npm run build:web` is enough for relay development, but it does not create the
download artifacts used by `/install` and `/downloads`.

Wrangler prints the deployment URL. Point the CLI at it with either form:

```sh
shell --server https://example.workers.dev <command>
SHELL_ONLINE_SERVER=https://example.workers.dev shell <command>
```

To use a custom domain, add a `routes` entry to the copied configuration. The
example uses generic binding names and contains no account identifiers or
credentials. Choose unique Rate Limiting namespace IDs if the defaults conflict
with another Worker in your account.

## Accounts app

The accounts app adds sign-in, organizations, linked machines, and a shared
session list. It needs Firebase Authentication and PostgreSQL.

```sh
cd app
cp .env.example .env
# Fill in Firebase values, POSTGRES_PASSWORD, WEB_ORIGIN, and RELAY_URL.
docker compose up --build -d
```

Add the value of `WEB_ORIGIN` to Firebase's authorized domains. The container
serves the client and API together on port 8080 and proxies `/relay/*` to
`RELAY_URL`.

Point account commands at a self-hosted app:

```sh
SHELL_ONLINE_ACCOUNTS=https://app.example.com \
SHELL_ONLINE_WEB=https://app.example.com \
shell login
```

For a Cloudflare deployment, `app/wrangler.jsonc` is a template. Copy it if you
want to preserve the hosted defaults, set your Worker name, route, origins,
`HYPERDRIVE_ID`, `FIREBASE_PROJECT_ID`, and `MAIL_FROM`, then run:

```sh
cd app
npm ci
npm run build
npm run render:deploy-config
npx wrangler deploy --config wrangler.deploy.jsonc
```

The Worker expects a `HYPERDRIVE` binding to PostgreSQL. Set `MAIL_API_KEY` with
`wrangler secret put` only if invitation email is enabled. Database migrations
are in `app/server/lib/migrations/`; apply them with `npm run db:migrate` before
deploying code that depends on a new migration.

## Updating

Pull the desired tag, rebuild, and deploy it. Do not reuse a persistent state
file with a different relay unless you intend to move that session. Back up the
PostgreSQL database and Docker volumes before upgrading the accounts app.
