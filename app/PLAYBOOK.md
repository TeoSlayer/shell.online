# Testing and deploying a change

Written after a run of deploys where several looked like they had worked and
had not. Each step below exists because skipping it produced a specific
failure in production, named where it applies.

There are **two Workers**, and a change usually belongs to only one:

| Worker | Serves | Config | Built from |
|---|---|---|---|
| `shell-online-app` | `app.shell.online` — the web app and `/api/*` | `app/wrangler.jsonc`, rendered | `app/` |
| `shell-online` | `shell.online` — the site, the relay, `/install`, `/downloads` | `wrangler.production.jsonc` (private, gitignored) | repository root |

Changing `app/**` means the app Worker. Changing `cmd/shell/**` means the CLI,
which only reaches anyone through **published binaries**, which are static
assets of the relay Worker. There is no third place.

## 1. Test

```sh
cd app
npm run typecheck
npx vitest run
```

The store suite runs against the in-memory store here and against real
Postgres in CI. A change to `server/lib/store*.ts` is not proven locally.

For CLI changes, from the repository root:

```sh
go test ./...          # add -race to match CI
gofmt -l cmd internal  # must print nothing
```

## 2. Build, and read the exit code

```sh
cd app
npm run build
echo $?                 # must be 0
```

**Do not pipe this to `tail`.** A pipeline's exit status is the last command's,
so `npm run build | tail -2` reports success for a failed build. That shipped a
stale bundle once: the build failed on a merge conflict marker and the deploy
went ahead with the previous `dist`.

`npm run build` ends with `check-bundle`, which refuses a bundle whose required
values are missing or empty. Trust it, but know what it cannot see: it checks
what was compiled, not whether the values are *correct* for this environment.

**The build needs `app/.env.local`.** The Firebase configuration is not in the
repository. A build from a clean checkout or a `git worktree` has no
`.env.local`, compiles a client with no Firebase configuration, and that client
throws while it is still loading. The page then answers **200 with an empty
body, no failed requests and nothing in the console** — a module that throws
during evaluation does not reliably reach the console. This is the single
easiest way to take the app down and the hardest to read afterwards.

## 3. Deploy

### The app Worker

`app/wrangler.jsonc` is a template. Deploying it directly fails with
`Invalid hyperdrive database ID '__HYPERDRIVE_ID__'`.

```sh
cd app
export CLOUDFLARE_ACCOUNT_ID=<account>
export HYPERDRIVE_ID=<id> FIREBASE_PROJECT_ID=<project> MAIL_FROM='...'
npm run render:deploy-config
npx wrangler deploy --config wrangler.deploy.jsonc
echo $?
```

### The relay Worker

```sh
npm run deploy:production      # from the repository root
```

That rebuilds the site *and* every release binary before deploying, because a
Workers asset deployment replaces the whole manifest: deploying a web-only
build removes `/downloads` entirely.

## 4. Prove it stuck

```sh
cd app
node scripts/verify-deploy.mjs https://app.shell.online
```

This compares the asset hashes in your local `dist/index.html` against what the
origin serves. It exists because **a deploy can report success and go on
serving the previous `index.html`**: the hashed assets upload, wrangler prints
"No updated asset files to upload", and the document pointing at them stays
behind. A fix is then live, reachable at its own URL, and invisible. It
happened twice before this check existed. Deploy again if it fails.

Then check the thing actually renders, not just that it answers:

```sh
curl -s https://app.shell.online/api/health
curl -s https://app.shell.online/api/ready       # a real query through Hyperdrive
```

A blank page returns 200. If anything looks wrong, get the real error by
re-importing the entry module in the page — a module that throws during
evaluation may leave the console empty:

```js
import('/assets/index-XXXX.js').then(() => 'ok').catch(e => e.message)
```

## 5. Releasing the CLI

Binaries carry a version. Never republish different bytes under a version that
is already tagged: the artifacts and the tag then disagree, which happened
with 0.10.1 and is why 0.11.0 exists.

1. Bump `package.json`, `CHANGELOG.md`, `docs/content.json`, `index.html`
   (`softwareVersion`), `public/llms.txt`, and the formula URL
2. `npm test` at the root checks these agree
3. Merge, tag, then fill in the Homebrew checksum, which cannot be known
   before the tag exists:

```sh
git tag vX.Y.Z && git push origin vX.Y.Z
curl -fsSL https://github.com/TeoSlayer/shell.online/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
```

4. `npm run deploy:production` publishes the binaries

## A schema change and the code that needs it

The set of audit kinds lives in three places that must agree: the check
constraint in the database, `KINDS` in `server/routes/audit.ts`, and the union
in `server/lib/types.ts`. Only the first one bites, and it bites only against
Postgres:

```
new row for relation "audit_events" violates check constraint
"audit_events_kind_check"
```

Every test passed. The in-memory store has no constraints, so adding a kind to
the code and forgetting the migration is invisible until production. It took
the service down for stopping a session, because a failed audit write was
allowed to fail the request that triggered it.

Two rules follow:

1. **Migrate before deploying.** `deploy-app.yml` already does them in that
   order. A deploy by hand has to do the same.
2. **Never let writing the trail break the thing being recorded.** An operator
   stopping a runaway process should not be told "internal error" because the
   log could not be written. Failures are logged loudly instead.

## What has actually gone wrong

Every one of these shipped:

- **A dev URL compiled into the bundle.** Vite applies `.env.local` to every
  build on the machine that has one, and there was no `.env.production` to
  override it. Guarded by `check-bundle`.
- **A blank page from missing Firebase configuration**, built from a worktree.
  Guarded by `check-bundle` only after it had already happened.
- **A deploy serving the previous `index.html`.** Guarded by `verify-deploy`.
- **Hyperdrive caching reads.** Every read here is read-after-write by the
  person who just acted, so caching made the service disagree with itself.
  Caching is off on the configuration; it is not a field this repository can
  set, so `app/wrangler.jsonc` records it next to the binding.
- **`run_worker_first` without wildcards.** `"/api/"` is a glob matching that
  literal path and nothing under it, so every API request fell through to the
  assets and got `index.html`. It is not needed: the Worker already runs first.
