# Contributing to shell.online

Help someone start a session, use it from anywhere, or share it safely.
Small fixes, clearer docs and reproducible bug reports are welcome.

## Start here

- For a substantial behavior change, open an issue first so the scope can be agreed.
- Keep the basic no-account sharing flow simple. Account features belong in the optional app.
- Use synthetic examples. Never publish real share links, passwords, MCP bearers, terminal transcripts, analytics exports or deployment secrets.
- Report vulnerabilities [privately](SECURITY.md), not in a public issue.
- Find the code in the [repository map](../README.md#find-your-way-around) and the [guide index](../docs/README.md).

## Run the checks for your change

Run commands from the repository root. Go work uses the version in `go.mod`
(currently 1.26.8). JavaScript work uses Node.js 22+ and npm; install the locked
dependencies with `npm ci`, or `npm --prefix app ci` for the app.

For README changes, also run `node scripts/test-landing-seo.mjs`: it checks
guide discovery and security wording without installing dependencies.

| You changed… | Local verification |
| --- | --- |
| Markdown or issue templates only | Check relative links, render the Markdown, and validate any YAML forms. No runtime build is needed for prose-only changes. |
| Public website, viewer, relay, shared TypeScript or `docs/content.json` | `npm run check` and `npm run build:web` |
| Go CLI or host | `go test -race ./...`, `go vet ./...`, and `gofmt` on changed Go files |
| Accounts app or game | `npm --prefix app run typecheck`, `npm --prefix app run lint`, and `npm --prefix app test`; follow [app setup](../app/README.md) for a build |
| Database behavior | App checks above, plus `npm --prefix app run test:pg` against a disposable test database—not production |
| Wire protocol or terminal snapshots | Relevant Go and TypeScript suites, `npm --prefix app run check:protocol`, and `npm run test:terminal-snapshot` |
| Dependencies or security-sensitive behavior | Relevant suites above and `go run golang.org/x/vuln/cmd/govulncheck@latest ./...` for Go changes; review CI security results |

Use all relevant rows when a change spans components. Add a regression that
fails without the fix. For UI changes, check narrow mobile and desktop layouts
and include a synthetic screenshot. Record exact commands, results and checks
you could not run; “all green” without scope is not enough. CI still runs its
full configured checks for pull requests.

## Keep changes focused

- Describe the user-visible outcome and why the change is needed.
- Update [CHANGELOG.md](../CHANGELOG.md) for user-visible changes.
- Do not mix unrelated refactors or deployment configuration changes into a fix.
- Keep temporary plans, model transcripts, screenshots from real sessions, test captures and deployment evidence outside the repository. Keep maintained guides, reusable tests and required fixtures.
- By contributing, you license your contribution under the repository's [MIT License](../LICENSE).

### Documentation

Public guide copy lives in [`docs/content.json`](../docs/content.json). Its
version must match `package.json`; preserve its schema and older-release
support. Run `npm run check` and `npm run build:web` when changing it. Update
related CLI help, README and `public/llms.txt` when a documented flow changes.

### Security boundaries

New CLI sessions use E2EE unless the owner explicitly chooses `--no-e2ee`.
Startup, structured output, persistence and Docker changes must preserve that
default, the password flow and access checks, with regression coverage. Never
equate account listing access with terminal-content access or observation with
permission to type. Keep protocol copies synchronized and preserve replay
protection. Update the [security policy](SECURITY.md) and related guides when
their described behavior changes.

## Deployment is a separate step

A code review is not a production rollout. The app and game have path-filtered
deployment workflows on `main`; even an `app/` documentation change can trigger
the app workflow. Check the affected paths before merging.

Maintainers deploy the hosted relay through `npm run deploy:production`, which
builds and verifies the full web/download bundle. Do not substitute a web-only
upload. A CLI install does not update running hosts. See [self-hosting](../docs/self-hosting.md)
and the relevant component guide for operator setup.
