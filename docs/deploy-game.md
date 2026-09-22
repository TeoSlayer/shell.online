# Optional separate game deployment

This is an operator reference for splitting the game into its own Cloudflare
Worker. It is **not required for normal app setup**. The repository includes
the build and workflow, but the separate Worker's route is disabled by default.
Do not interpret a successful build as a live routing change.

## Why it is split at all

`shell-online-app` serves the session list, the terminal, the vault and the
API. The game is a large amount of code that no paying use of the product
depends on. While it shipped inside that Worker, a bad game build was a bad
console build: the same deploy, the same rollback, the same blast radius.

Split, the game can be deployed, rolled back or switched off without the
console noticing, and `deploy-game.yml` runs only when the game's own files
change.

## What is already true

| Piece | Where |
|---|---|
| The page | `app/game.html` and `app/src/game/main.tsx` |
| The build | `app/vite.game.config.ts` → `npm run build:game` → `app/dist-game/` |
| The Worker | `app/wrangler.game.jsonc` — name `shell-online-game` |
| The pipeline | `.github/workflows/deploy-game.yml` |

The Worker has **no `main`**: it serves static files and nothing else. No
database binding, no mail, no cron, no secrets. It needs none of them, because
the game calls `/api/*` on the same origin and every one of those lives in the
console's Worker, which is also what migrates the game's two tables.

The pipeline typechecks, runs the game's own tests and the readability rules
before it builds. A game that breaks its own rules is not deployed, however
green the console is.

## The decision that is left: same origin, or its own host

The game must be served from **the same origin as the console**. Sign-in is a
Firebase ID token and Firebase persists per origin, so a second hostname means a
second sign-in and an API on the far side of CORS. The isolation wanted here is
of *deployments*, not of identity.

Same origin and a separate Worker means path routing: `app.shell.online/game*`
to `shell-online-game`, everything else to `shell-online-app`. One thing is in
the way. `shell-online-app` claims `app.shell.online` as a **custom domain**,
which takes the whole hostname; a second Worker on a path of it needs the
console moved to a zone route first:

```jsonc
// app/wrangler.jsonc — today
"routes": [{ "pattern": "app.shell.online", "custom_domain": true }]

// what path routing needs
"routes": [{ "pattern": "app.shell.online/*", "zone_name": "shell.online" }]
```

That is a change to production routing for the console, so it is a decision to
take deliberately rather than a side effect of merging the game. Until it is
taken, `wrangler.game.jsonc` carries **no route**: the Worker deploys and is
reachable by nothing, which is the safe half of the arrangement — the pipeline
can be proven before any traffic is pointed at it.

## Switching it on

1. Move the console to a zone route (the second block above) and deploy it.
2. Uncomment the `routes` line in `app/wrangler.game.jsonc`.
3. Run **Deploy game**. Check `https://app.shell.online/game` loads and signs in.
4. Remove the lazy `/game` route from `app/src/App.tsx` and the game's files
   from `deploy-app.yml`'s path filter, so the console stops building a copy it
   no longer serves.

Step 4 is what turns the split from two copies into one, and it is worth doing
only once steps 1–3 are proven.

## Rolling back

The game has no schema of its own to unwind, so a rollback is only the Worker:

```
npx wrangler rollback --config app/wrangler.game.jsonc
```

To take the game away entirely, delete the route and the console's own `/game`
link. Nothing in the console reads anything the game writes; `game_profiles`
and `game_collection_runs` are only ever read by the game's own endpoints.

## What the console's deploy still owns

The game's two tables. `deploy-app.yml` migrates, then `verify-schema.ts`
checks every table the Worker reads exists — `game_profiles` and
`game_collection_runs` are in that list, so a console deploy that reached
production without them fails there rather than on the first request to the
keep.
