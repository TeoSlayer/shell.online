# shell.online accounts app

The optional React app behind `app.shell.online`. It provides accounts,
organizations, linked machines, session lists, comments, and browser-started
sessions. The CLI and relay work without it.

Firebase remains the default hosted sign-in. Self-hosters can instead set an
OpenID Connect issuer and public client id; that enables Authorization Code
with PKCE and leaves registration, passwords and recovery with the provider.
The two modes share the same API and account data model.

The provider needs one public client, PKCE with S256, whose redirect URI is
`<WEB_ORIGIN>/auth/callback` and whose allowed web origin is `<WEB_ORIGIN>` —
the second is what lets the hidden iframe renew a session before it expires.

## Local development

Requirements: Node.js 22, npm, one configured sign-in provider, and PostgreSQL
for database-backed tests.

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

The client reads either the complete `VITE_FIREBASE_*` set or both
`VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID` at build time. OIDC takes
precedence only when both values are present; partial configurations fail the
deployment check instead of producing a broken sign-in screen.
The server uses:

| Variable | Purpose |
|---|---|
| `OIDC_ISSUER` | The provider whose ID tokens are accepted; falls back to `VITE_OIDC_ISSUER` |
| `OIDC_AUDIENCE` | The `aud` tokens must carry, normally the client id; falls back to `OIDC_CLIENT_ID` |
| `OIDC_JWKS_URI` | Optional. Discovered from the issuer when absent |
| `FIREBASE_PROJECT_ID` | Firebase project whose ID tokens are accepted when OIDC is not configured |
| `DATABASE_URL` | PostgreSQL connection string; required in production |
| `WEB_ORIGIN` | Public origin used for CORS and links |
| `RELAY_URL` | Relay proxied through `/relay/*` |
| `MAIL_API_KEY`, `MAIL_FROM` | Optional invitation email |
| `MAIL_PROVIDER`, `MAIL_API_URL` | Optional non-SendGrid JSON provider |
| `FEEDBACK_TO` | Optional address that feedback sent from the app is forwarded to |
| `TRUST_PROXY` | Set to `1` only behind a trusted proxy |
| `STATS_TOKEN` | Optional, 32+ characters: lets the relay's statistics dashboard read account counts and sign-up cohorts |
| `STATS_EXCLUDE` | Optional: addresses and domains whose accounts are left out of every statistics figure, for your own team's accounts. Comma or space separated; an entry with a local part matches that address, one without matches the domain and its subdomains. The dashboard reports how many accounts it left out |

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
Set `FEEDBACK_TO` as a Worker variable to have feedback sent from the app
forwarded by email; without it, feedback is kept in the `feedback` table only.
Keep Hyperdrive query caching disabled because the app depends on read-after-write
consistency.

The full relay and app setup is documented in [the self-hosting guide](../docs/self-hosting.md).

## Structure

- `src/` — React client
- `server/` — API, stores, and migrations
- `worker/` — Cloudflare Worker adapter
- `src/terminal/` — relay protocol, E2EE, opt-in file browsing, and selectable
  rendering; xterm.js is the default, while Refstream (unstable alpha) adds backed file
  references and revocable read/control agent invitations alongside its local
  find, command, export, theme, sizing, and back-to-live tools. Its agent
  connection and retained task state survive panel changes and reconnects; a
  tab-local snapshot supports reload recovery while the shell process remains live
- `scripts/` — build and deployment checks

`npm run check:protocol` verifies that the app's terminal protocol files match
the relay implementation.
