# Contributing

Thanks for helping improve shell.online.

## Before opening a change

- Use an issue for substantial behavior changes so the design can be agreed first.
- Keep the no-account, one-command product model intact.
- Never include real share links, terminal transcripts, credentials, analytics exports, or Cloudflare secrets in issues, fixtures, screenshots, or commits.
- Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Local checks

Install Go 1.26.8, Node.js 22+, and npm, then run. The release toolchain is intentionally pinned because Go 1.27.x has a MIPS64 runtime regression:

```sh
npm ci
npm run check
npm run build:web
go test -race ./...
go vet ./...
test -z "$(gofmt -l ./cmd ./internal)"
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

## Pull requests

Keep changes focused, add regression tests for fixes, and describe the user-visible behavior and security implications. By contributing, you agree that your contribution is licensed under the repository's MIT License.

New issues and pull requests receive an automated, LLM-assisted intake review. Two conservative reviews must independently agree with at least 98% confidence before an external issue is deleted or an unrelated pull request is closed. Product criticism and imperfect but relevant changes remain in scope; advertising, scams, unrelated content, and content-free generated noise do not. Maintainer submissions are never removed automatically. The model cannot execute submitted code, merge changes, or approve a pull request, and maintainers can override every non-deletion decision.

The pull-request review also checks the submitted diff for concrete problems and proposes a changelog entry. User-visible changes should update [`CHANGELOG.md`](CHANGELOG.md); published GitHub releases receive a generated summary that preserves any human-written release notes.

Documentation copy lives in [`docs/content.json`](docs/content.json) and renders both the current site and tagged, release-selectable docs. Keep its version equal to `package.json`, preserve the schema, and run the SEO test through `npm run check` after editing it.

E2EE is the default product invariant for new CLI sessions; only an explicit `--no-e2ee` may opt out. Changes to session startup, structured output, persistent state, or Docker entrypoints must preserve the browser-password flow, prevent accidental downgrade, and include regression tests. Update the built-in CLI help, README, security policy, agent skill, `public/llms.txt`, and versioned documentation together when that flow changes.

## Production deployment

Use `npm run deploy:production`. It rebuilds and verifies the complete web and download bundle before invoking Wrangler. Do not deploy directly after `npm run build:web`: Workers asset manifests are replaced atomically, so omitting `dist/downloads` would remove the public installers and binaries.
