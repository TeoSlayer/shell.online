# Deploying the platform

One container serves three things: the built client, the accounts API, and a
proxy to the relay. They are one deployment on purpose.

## Why one origin

The relay refuses a websocket whose `Origin` is not its own, and the browser
sets that header from wherever the page was served. An app on `app.example.com`
therefore cannot open a terminal socket to a relay on `shell.online` — the
relay is right to refuse it, and relaxing that check would weaken every
deployment of the relay, not just this one.

So the service serves the client and forwards `/relay/*` to the relay with the
`Origin` rewritten. The browser talks to one origin; the relay sees a request
from itself. `server/lib/relay-proxy.ts` does the forwarding and
`server/lib/static-files.ts` serves the client.

The proxy cannot read anything it carries. Terminal frames are encrypted in the
browser before they reach the relay, and the proxy handles the same ciphertext.

## Configuration

Everything is read once at boot by `server/lib/config.ts`, which refuses to
start on a bad value rather than failing on the first request that needs it.

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | in production | Postgres. Refused as absent under `NODE_ENV=production`, because the file store is one process rewriting a whole file per mutation. |
| `FIREBASE_PROJECT_ID` | yes | Project whose ID tokens are accepted. |
| `WEB_ORIGIN` | yes | Where browsers reach this deployment. Used for CORS and for the links the CLI is sent to, so it is the public URL. |
| `RELAY_URL` | when serving the client | Relay to forward `/relay/*` to. |
| `CLIENT_DIR` | to serve the client | Directory holding the built client. Set in the image. |
| `PORT` / `HOST` | no | Defaults to 8080, and to `0.0.0.0` under `NODE_ENV=production`. |
| `TRUST_PROXY` | no | Set to `1` only behind a proxy that rewrites `X-Forwarded-For`. Believing it otherwise lets a caller pick a new address per request and walk past the rate limiter. |
| `MAIL_API_URL`, `MAIL_API_KEY`, `MAIL_FROM` | no | Where to post an invitation email, and as whom. All three or none: with any missing, invitations are logged instead of sent and the link still works. |

The `VITE_*` values are compiled into the client, so they are build arguments
rather than container environment. Changing one needs a rebuild.

## Running it

```sh
cp .env.example .env && $EDITOR .env
docker compose up --build
```

Anywhere that runs a container — Fly, Render, Cloud Run — takes the same image
with the same variables and a managed Postgres.

## Sending invitations

An invite is a link, and a link somebody has to be told about by hand mostly
does not get accepted. When an invite is created with an email address, the
service sends it.

There is no mail library and no vendor in the code. `server/lib/mail.ts` posts
one JSON body — `{from, to, subject, html, text}` — to `MAIL_API_URL`, which is
the shape Resend, Postmark and Mailgun all accept, so the deployment picks the
provider. With the three `MAIL_*` variables unset the message is logged, link
included, which is what a developer wants and what stops an unconfigured
deployment from failing an invite that is otherwise perfectly good.

Sending is best effort: a provider having a bad afternoon must not throw away
an invite the inviter can still copy and paste.

## The schema

`server/lib/migrations/*.sql`, applied at boot under an advisory lock so two
instances starting together do not both try. Each file's checksum is recorded;
editing one that has already been applied is an error at startup rather than
two databases that disagree while claiming the same version.

**Changing the schema means adding a numbered file, never editing one.** That
is also what makes a rollback safe: migrations only ever add, so the previous
image meets a schema it still understands.

## Moving an existing file store in

```sh
DATABASE_URL=postgres://... npm run db:import -- .data/accounts.json
```

It writes through the `Store` interface, so every record lands under the same
constraints a live write does. Running it twice is safe.

## What the service does under load

- **Rate limiting** is a token bucket per caller. Minting or exchanging
  credentials draws on a budget a person cannot notice and a script exhausts in
  a second; everything else shares a much larger one, because an agent polls
  every two seconds and must never be refused. Buckets are per instance, so two
  instances allow up to twice the limit between them — the trade for not making
  a round trip to shared storage on every request.
- **Faults** answer 500 with a fixed sentence and log the detail. A driver's
  message describes this service's schema, not the caller's mistake.
- **`/api/health`** answers before anything can refuse it and touches no
  dependency, so a busy database does not get containers restarted.
  **`/api/ready`** makes a cheap read, so a rolling deploy waits instead of
  sending traffic into errors.
- **SIGTERM** stops accepting, drains what is in flight, then releases the pool.

## Before this faces real users

- **Firebase.** The client currently authenticates against `vv-cloud-firebase`,
  which is borrowed. A dedicated project needs billing enabled; see the README.
- **The audit log stores plaintext input.** Prompts and commands are recorded so
  a colleague can read them back, which means they are readable by this service
  in a way terminal output deliberately is not. That is a policy decision to
  make explicitly, not an oversight.
