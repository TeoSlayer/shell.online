# Shell Keep

The game skin over `app.shell.online`. Everything the game is lives in this
directory and in `src/styles/game.css`. Nothing else in the application knows
it exists, except at the handful of seams listed below.

## Why it is isolated

Two reasons, and the second is the one that bites.

**Cost.** The keep carries a renderer, a sprite atlas and a stylesheet of its
own. None of that belongs in the bundle somebody downloads to look at a list of
sessions, so it is reached through one dynamic import and travels in its own
chunk. `npm run verify:bundle` fails the build if any of it reaches the entry
bundle — it looks for `SHELL_KEEP_MARKER`, which the game writes onto the DOM.

**Blast radius.** A game is a large amount of code that no paying use of this
product depends on. Keeping it behind one import means it can be changed,
broken or removed without touching the console, and it means a reviewer can see
at a glance that a change to the keep cannot have changed how a session starts.

## The seams

Six, all of them small, all of them deliberate. If you are adding a seventh,
that is worth a conversation first.

| File | What it does |
|---|---|
| `src/App.tsx` | One lazy route at `/game`, and `SignedInApp` split out so the QA harness can mount the app under a stand-in identity |
| `src/components/AppShell.tsx` | The `LaunchGame` button at the right of the top bar |
| `src/styles/shell.css` | That button's styles, `.launch-game*` |
| `src/auth/AuthProvider.tsx` | `AuthContext` is exported so the QA harness can supply an identity. No guard changed |
| `src/lib/api.ts` | `request` is exported, so the game calls its own endpoints without a second copy of the token handling and the error sentences |
| `scripts/check-bundle.mjs` | The guard that keeps all of the above honest |

The game also owns a slice of the service, which is not a seam so much as its
own corner: `server/routes/game.ts`, the `game_profiles` table in migration
014, and two methods on the `Store` interface. Nothing else on the server
reads them.

Nothing in this directory imports from `src/routes`, and nothing outside it
imports from here except through those seams.

## Layout

```
assets/    sprites, palettes, and the rules that build them
engine/    loop, canvas layers, input, sprite cache
scenes/    what gets drawn: the field, and the things on it
state/     options, game state, what is saved
ui/        the DOM interface over the canvas: HUD, menus, shop
lore/      names, flavour, and the codex
```

## Running it

```sh
npm run dev
```

- `http://localhost:5173/qa.html` — **the whole app, signed in.** This is what
  to test: the route inside the product, the controller in the top bar, and the
  way back out to the session list. Calls to the service will fail, because the
  identity is a stand-in and the server checks a real token; those error states
  are worth seeing.
- `http://localhost:5173/game-preview.html` — the game on its own, for working
  on the artwork without the app around it.

Neither page is an input to `vite build`, which builds `index.html` and nothing
else, so both exist in development and in no deployment.

## Working on the art

Sprites are palette-indexed text; see `assets/sprite.ts` for why that rather
than PNGs. Two tools matter:

```sh
npx tsx scripts/sprite-sheet.ts out.html   # every sprite, magnified, captioned
npm test                                   # the atlas test: miscounts, holes, footprints
```

The atlas test catches what a diff cannot — a row one character short shifts
every pixel after it and simply looks badly drawn. The contact sheet catches
what a test cannot, which is whether the thing looks like what it is meant to
be.

## The rules the game is held to

`scripts/check-game-ui.mjs` runs in `npm test` and enforces the
`game-ui-design` skill: a 16px floor for text, 44px for anything you can hit,
motion at or under 300ms, a bounded z-index scale, a visible focus ring, a
reduced-motion escape, and no physical button named anywhere except the one
table that knows what the player is holding.
