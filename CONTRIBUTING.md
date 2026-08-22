# Contributing

Thanks for helping improve shell.online.

## Before opening a change

- Use an issue for substantial behavior changes so the design can be agreed first.
- Keep the no-account, one-command product model intact.
- Never include real share links, terminal transcripts, credentials, analytics exports, or Cloudflare secrets in issues, fixtures, screenshots, or commits.
- Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Local checks

Install Go 1.27+, Node.js 22+, and npm, then run:

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
