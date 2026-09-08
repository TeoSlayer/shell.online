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
| `MAIL_API_KEY`, `MAIL_FROM` | no | SendGrid credentials for invitation email. The From address must be a verified Sender Identity or every send returns 403. With either missing, invitations are logged instead of sent and the link still works. |
| `MAIL_PROVIDER`, `MAIL_API_URL` | no | Set `MAIL_PROVIDER=json` with a `MAIL_API_URL` to post a flat `{from,to,subject,html,text}` body instead, which Resend and Postmark accept. Defaults to SendGrid. |

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

There is no mail library: a send is one HTTPS POST, and a dependency that
exists to build a JSON body is one more thing to keep patched for nothing.
`server/lib/mail.ts` speaks SendGrid by default — which nests the recipient
inside `personalizations` and the body inside `content`, so it cannot share a
request builder with the flat providers — and `MAIL_PROVIDER=json` switches to
the flat body Resend and Postmark accept.

**The From address must be a verified Sender Identity in the SendGrid account.**
An unverified one fails every send with 403, and the error message SendGrid
returns is passed through to the log, because otherwise the only symptom is an
invitation nobody receives.

With the key or the sender unset the message is logged, link included, which is
what a developer wants and what stops an unconfigured deployment from failing
an invite that is otherwise perfectly good.

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

- **Firebase.** Development points at an existing Google Cloud project borrowed
  from elsewhere in the organization, which means a shared user pool and
  password-reset mail signed by another team. A deployment needs its own
  project with Identity Platform enabled and billing on. Which project is used
  is a `.env.local` change, nothing in the code.
- **Terminal input is never copied to the accounts service.** The activity data
  is limited to collaboration metadata such as explicit handoffs. The normal
  housekeeping sweep also deletes plaintext input rows written by prerelease
  builds.
