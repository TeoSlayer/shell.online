# Self-hosting

The CLI only needs a relay. Choose the standalone Docker deployment for a
normal server, or the Worker deployment for Cloudflare's edge.

## Standalone Docker relay

Requirements: Docker Engine with Compose, a public domain, and ports 80/443.

```sh
git clone https://github.com/TeoSlayer/shell.online.git
cd shell.online/standalone

SHELL_ONLINE_PUBLIC_URL=https://relay.example.com \
SHELL_ONLINE_SITE=relay.example.com \
docker compose up -d --build
```

Point the domain's A/AAAA record at the host first. Caddy obtains TLS
automatically. For a local HTTP test, the defaults work at `http://localhost`:

```sh
docker compose up -d --build
curl http://localhost/api/health
```

Use the relay without changing the installed CLI:

```sh
SHELL_ONLINE_SERVER=https://relay.example.com shell claude
shell --server https://relay.example.com claude
```

`relay-state` stores session metadata and host-token hashes so persistent
clients can recover the same identity after a relay restart. It does not store
terminal contents, E2EE keys, or browser passwords. Back up this volume and run
one relay replica per volume. Live sockets reconnect after a restart.

The standalone server enforces the hosted protocol's authentication,
same-origin browser policy, read-only mode, input lease, viewer/frame/traffic
limits, slow-client protection, stable terminal grid, and task-bound expiry.
Terminal frames remain opaque to the relay when the CLI's default E2EE is used.

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHELL_ONLINE_PUBLIC_URL` | `http://localhost` in Compose | Exact public origin used in links and browser origin checks |
| `SHELL_ONLINE_SITE` | `http://localhost` | Caddy site address; use a hostname for automatic HTTPS |
| `SHELL_ONLINE_STATE_FILE` | `/var/lib/shell-online/relay.json` | Metadata state file inside the relay container |
| `SHELL_ONLINE_TRUST_PROXY` | `1` in Compose | Trust the first `X-Forwarded-For` address; enable only behind your proxy |

The standalone relay is a single-node deployment. It does not include the
optional accounts app or hosted analytics dashboard.

## Cloudflare Workers relay

Copy the credential-free example rather than editing it:

```sh
cp wrangler.example.jsonc wrangler.local.jsonc
npm ci
npm run build
npx wrangler deploy --config wrangler.local.jsonc
```

Set `SHELL_ONLINE_SERVER` to the URL Wrangler prints. Add a `routes` entry to
the copied config for a custom domain. The Worker path requires Durable
Objects, Rate Limiting, Analytics Engine, and static assets.

## Accounts app

Accounts are optional and do not participate in terminal transport. The app in
`app/` uses Firebase Authentication and PostgreSQL; its local Docker deployment
is documented in [`app/README.md`](../app/README.md).
