# shell.online web app

React front end for shell.online accounts. Sign up and sign in with email or
Google, then land on a guarded account surface. It reuses the design language of
the shell.online marketing site rather than approximating it: the same Uncut Sans
variable font, the same paper and ink tokens, and the same restrained transitions.

The CLI is unchanged. Accounts sit alongside it, they do not gate it.

## Run it

```sh
cp .env.example .env.local   # fill in the Firebase web app config
npm install
npm run dev:all              # web on :5173, accounts service on :8787
```

`npm run dev` runs the web app alone, `npm run dev:accounts` the service alone.
`npm run build` typechecks and bundles, `npm test` runs the suite, and
`npm run preview` serves the build with the same headers as dev.

### Running the whole loop locally

Three processes, all on loopback:

```sh
# 1. web app and accounts service
npm run dev:all

# 2. the relay, from a shell.online checkout
npm run build:web
npx wrangler dev --config wrangler.local.jsonc     # :8788

# 3. the CLI, pointed at all three
export SHELL_ONLINE_ACCOUNTS=http://127.0.0.1:8787
export SHELL_ONLINE_WEB=http://localhost:5173
export SHELL_ONLINE_SERVER=http://127.0.0.1:8788
go build -o /tmp/shell ./cmd/shell

/tmp/shell login            # approve in the browser
/tmp/shell sleep 120        # appears at localhost:5173/sessions
```

`wrangler.local.jsonc` is not in the shell.online repository; the production
Wrangler config is private. The file the CLI work added is untracked and
reproduced in that commit message.

## Routes

| Route      | Guard              | What it does                              |
|------------|--------------------|-------------------------------------------|
| `/login`   | redirects if authed | Email and password, or Continue with Google |
| `/signup`  | redirects if authed | Creates the account, sets the display name, sends verification |
| `/reset`   | redirects if authed | Sends a password reset link               |
| `/sessions` | requires auth      | Live list of shares from every linked machine |
| `/machines` | requires auth      | Linked machines, with per-machine unlink      |
| `/account` | requires auth       | Profile and email verification                |
| `/cli/authorize` | own guard     | Approves a `shell login` request              |

Signing in lands on `/sessions`, the page with something on it. `/` and any
unknown path redirect to `/login`.

The three signed-in pages share `AppShell`: a rail on the left carrying the
nav, the one command a new machine needs, and the account block at its foot
behind a separator; and a topbar carrying the page title and a live count. Only
the content column scrolls, and the topbar's inner measure matches the content
column so their right edges line up.

Below 900px the rail becomes a horizontal strip with the account moved beside
it. Three items fit without a drawer, so there is no menu state to manage.

`/cli/authorize` carries its own guard rather than `RequireAuth`, because it
has to send a signed-out user back to that exact URL with its query string
intact. Losing the query would lose the request the CLI made.

## Auth

Firebase Authentication, driven entirely from the client. `src/auth/AuthProvider.tsx`
owns the session and exposes the operations; `src/auth/RequireAuth.tsx` holds both
guards. Both guards wait for the first `onAuthStateChanged` before deciding, so a
signed-in user never sees the login page flash on reload.

Firebase error codes are not user-facing copy, so `src/lib/auth-errors.ts` maps the
reachable ones to plain sentences and falls back to a readable default rather than
leaking `auth/internal-error` into the UI.

### Which project this points at

Whichever one `.env.local` names. Development borrows an existing Google Cloud
project from elsewhere in the organization, because it already has Identity
Platform configured with email/password and Google sign-in, so the flow works
without provisioning anything.

That is an interim arrangement: a borrowed project means a shared user pool and
password-reset mail signed by another team. Anything real needs its own project
with Identity Platform enabled and billing on, which is a `.env.local` change
and nothing in the code.

`shell-online-auth` was created for that purpose and has the Firebase and Identity
Toolkit APIs enabled, but Identity Platform on a fresh project needs a billing
account linked, which was not available. Link billing, run:

```sh
curl -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     -H "x-goog-user-project: shell-online-auth" \
     "https://identitytoolkit.googleapis.com/v2/projects/shell-online-auth/identityPlatform:initializeAuth" -d '{}'
```

then enable the Google provider, add the production domain to `authorizedDomains`,
and repoint `.env.local`.

### Deployment note

Whatever serves the production build must send:

```
Cross-Origin-Opener-Policy: same-origin-allow-popups
```

`signInWithPopup` polls `window.closed` on the Google window. Under the default
COOP the browser severs that handle and the popup never resolves cleanly. This is
already set for `vite dev` and `vite preview` in `vite.config.ts`.

Every domain the app is served from also has to be listed in the Firebase project's
`authorizedDomains`, or Google sign-in returns `auth/unauthorized-domain`.

## Design

Tokens live in `src/styles/tokens.css`, lifted from the marketing site's
`web/landing.css` and `web/style.css`.

- **Accent.** `--blue` is the only accent on paper. `--acid` appears exclusively
  inside the dark terminal panel as the shell prompt color, which is how
  shell.online itself uses it.
- **Radius.** Chips 7px, inputs and buttons 10px, panels 18px. No exceptions.
- **Theme.** Light by default, following the marketing site. Dark mode reuses
  shell.online's own dark surface family and can be forced with
  `data-theme="dark"` or `"light"` on the root element. The primary button
  inverts in dark so it stays the highest-contrast element in both modes.
- **Contrast.** Every text and control pair passes WCAG AA in both themes.
- **Motion.** One staged entry fade and a 2px button lift. Everything collapses
  under `prefers-reduced-motion`.

### The terminal panel

`src/components/SessionPreview.tsx` is a real xterm.js instance, the same emulator
shell.online ships to viewers, replaying the real output of `shell claude`. The
escape codes are the ones `cmd/shell/session_output.go` actually writes. The
session id and password are illustrative; the rest is verbatim.

It is lazy-loaded because it is a third of the bundle and is hidden below 940px.

## Layout

Asymmetric split: form hard-left on paper, terminal right on dark. Below 940px the
terminal drops and the form becomes a single scrolling column.

## Accounts service

`server/` backs `shell login`. It runs on loopback and holds two things: the
CLI login handshake, and the per-user session registry.

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/cli/authorize` | Firebase ID token | Mints a one-time code for an approved login |
| `POST /api/cli/token` | none | Exchanges code plus verifier for CLI tokens |
| `POST /api/cli/refresh` | none | Renews the access token |
| `POST /api/cli/revoke` | none | Revokes a refresh token and everything from it |
| `GET /api/cli/me` | CLI token | The account a machine is linked to |
| `POST /api/sessions` | CLI token | Publishes a session |
| `PATCH /api/sessions/:id` | CLI token | Marks a session closed |
| `GET /api/sessions` | Firebase ID token | Lists the caller's sessions |
| `GET /api/devices` | Firebase ID token | Lists linked machines, secrets stripped |
| `DELETE /api/devices/:id` | Firebase ID token | Unlinks one machine |

Decisions worth knowing:

- **The CLI gets opaque scoped tokens, never the Firebase refresh token.** A
  Firebase refresh token is a full account credential. A scoped token can be
  revoked per device and only grants session registration.
- **Only hashes are stored.** A leaked store file yields nothing live.
- **`redirect_uri` is allowlisted to loopback callbacks** on unprivileged
  ports. Without that check a crafted authorize link could forward a live code
  to a remote host. The approve screen repeats the check so a bad link fails
  with an explanation rather than a generic error after the click.
- **Codes are single-use and burn even on a failed verifier**, so a stolen code
  cannot be retried.
- **Every query is scoped by uid at the store boundary**, so a route cannot
  leak another account's sessions.

`Store` is a JSON file for local development, behind an interface so Firestore
or D1 can drop in without touching route code. Set `ACCOUNTS_DATA` to move the
file, `ACCOUNTS_PORT` to change the port, and `WEB_ORIGIN` for CORS.

## Tests

```sh
npm test          # 128 tests: PKCE, redirect validation, codes, tokens,
                  # store migration, device scoping, session scoping,
                  # every route, and the web-side helpers
```

The Go side of this flow lives in the shell.online repository under
`internal/account` and `cmd/shell`.

## The embedded terminal

Clicking a running session opens it as a tab inside the app, with a real
terminal you can type into. It is not a link out to the standalone viewer.

`src/terminal/` holds the pieces:

- `protocol.ts` and `e2ee.ts` are **copied verbatim** from shell.online
  (`shared/protocol.ts`, `web/e2ee.ts`). The wire format and the browser half
  of the encryption are reused rather than reimplemented, so the two cannot
  drift apart in meaning. `npm run check:protocol` fails if they diverge from
  the sibling checkout, and runs as part of `npm test`.
- `connection.ts` owns one viewer connection: the socket, the retry policy and
  the cipher. It has no React and no xterm in it, so the parts worth testing
  are testable without a DOM.
- `TerminalPane.tsx` renders xterm and the password gate.
- `tabs.ts` is the tab reducer, also plain.

### Same-origin is a hard requirement

The relay refuses a websocket whose `Origin` is not its own
(`worker/index.ts`: `origin not allowed`). Verified: a socket from
`http://localhost:5173` to the relay gets **403**, one from the relay's own
origin connects.

So the app has to be served from the relay's origin in production. In
development they are separate ports, so `vite.config.ts` proxies `/relay` and
rewrites the `Origin` to the relay's own, which is what a same-origin browser
would have sent. `sessionSocketUrl()` picks the direct or proxied path by
comparing the share URL's origin with the app's.

If the app is ever deployed to a different origin than the relay, that check
has to grow an allowlist. It is not something this repository can decide.

### Passwords stay on the device

An encrypted session prompts inside the pane. The password derives the key
locally and is never sent anywhere, which is why the accounts service can hold
the `#salt=` fragment but the session still cannot be opened without it.

### Tabs

Open panes stay mounted while another tab is in front. Hiding rather than
unmounting keeps each socket and its scrollback alive, and a hidden pane is
moved off-screen rather than `display: none` because a zero-sized xterm would
resize the shared PTY to nothing. Opening a session that is already open
selects that tab instead of opening a second pane onto the same PTY.
