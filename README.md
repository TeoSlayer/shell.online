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
npm run dev                  # http://localhost:5173
```

`npm run build` typechecks and bundles. `npm run preview` serves the build with
the same headers as dev.

## Routes

| Route      | Guard              | What it does                              |
|------------|--------------------|-------------------------------------------|
| `/login`   | redirects if authed | Email and password, or Continue with Google |
| `/signup`  | redirects if authed | Creates the account, sets the display name, sends verification |
| `/reset`   | redirects if authed | Sends a password reset link               |
| `/account` | requires auth       | Account details, resend verification, sign out |

`/` and any unknown path redirect to `/login`.

## Auth

Firebase Authentication, driven entirely from the client. `src/auth/AuthProvider.tsx`
owns the session and exposes the operations; `src/auth/RequireAuth.tsx` holds both
guards. Both guards wait for the first `onAuthStateChanged` before deciding, so a
signed-in user never sees the login page flash on reload.

Firebase error codes are not user-facing copy, so `src/lib/auth-errors.ts` maps the
reachable ones to plain sentences and falls back to a readable default rather than
leaking `auth/internal-error` into the UI.

### Which project this points at

It currently runs against the `shell.online` web app inside the **`vv-cloud-firebase`**
Google Cloud project. That project already has Identity Platform configured with
email/password and Google sign-in enabled, so this works today.

It is an interim host. That project is Vulture Vision's, which means a shared user
pool and password reset emails signed "Vulture Labs team". Moving to a dedicated
project is a `.env.local` change, nothing in the code.

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
