# shell.online accounts app

The optional React app behind `app.shell.online`. It provides accounts,
organizations, linked machines, session lists, comments, and browser-started
sessions. The CLI and relay work without it.

## Local development

Requirements: Node.js 22, npm, Firebase Authentication, and PostgreSQL for
database-backed tests.

```sh
cp .env.example .env.local
npm ci
npm run dev:all
```

The client runs on `http://localhost:5173`; the API runs on
`http://127.0.0.1:8787`.

Useful commands:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run db:up
npm run test:pg
```

## Configuration

The client reads `VITE_FIREBASE_*` at build time. The server uses:

| Variable | Purpose |
|---|---|
| `FIREBASE_PROJECT_ID` | Firebase project accepted by the API |
| `DATABASE_URL` | PostgreSQL connection string; required in production |
| `WEB_ORIGIN` | Public origin used for CORS and links |
| `RELAY_URL` | Relay proxied through `/relay/*` |
| `MAIL_API_KEY`, `MAIL_FROM` | Optional invitation email |
| `MAIL_PROVIDER`, `MAIL_API_URL` | Optional non-SendGrid JSON provider |
| `TRUST_PROXY` | Set to `1` only behind a trusted proxy |

See [`.env.example`](.env.example) for the complete development configuration.

## Database

Migrations live in `server/lib/migrations/` and are applied in filename order.
Add a migration instead of editing one that has already shipped.

```sh
DATABASE_URL=postgres://... npm run db:migrate
```

The in-memory store is for tests and local development. Production requires
PostgreSQL.

## Deployment

For a container deployment:

```sh
cp .env.example .env
docker compose up --build -d
```

For Cloudflare Workers, fill the placeholders in `wrangler.jsonc` through the
render script, migrate the database, then deploy:

```sh
npm run build
DATABASE_URL=postgres://... npm run db:migrate
HYPERDRIVE_ID=... FIREBASE_PROJECT_ID=... MAIL_FROM=... \
  npm run render:deploy-config
npx wrangler deploy --config wrangler.deploy.jsonc
```

Set `MAIL_API_KEY` with `wrangler secret put` if invitation email is enabled.
Keep Hyperdrive query caching disabled because the app depends on read-after-write
consistency.

The full relay and app setup is documented in [`../SELF-HOSTING.md`](../SELF-HOSTING.md).

## Structure

- `src/` — React client
- `server/` — API, stores, and migrations
- `worker/` — Cloudflare Worker adapter
- `src/terminal/` — relay protocol, E2EE, and xterm integration
- `scripts/` — build and deployment checks

`npm run check:protocol` verifies that the app's terminal protocol files match
the relay implementation.
