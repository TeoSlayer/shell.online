# Find the right guide

Start with the [website docs](https://shell.online/docs/) for using shell.online.
The files below are references for specific features, operators and contributors.

## Use shell.online

| You want to… | Guide |
| --- | --- |
| Open your first session | [Quick start](https://shell.online/docs/) |
| Install, update or build from source | [Installation](https://shell.online/platforms/) |
| Use a phone or fix a connection | [Mobile](https://shell.online/mobile/) · [Troubleshooting](https://shell.online/reliability/) |
| Share safely or recover access | [Security](https://shell.online/security/) · [Passwords](https://shell.online/e2ee/) |
| Connect another agent | [MCP quick start](https://shell.online/agents/) |
| Look up a command | [CLI reference](https://shell.online/cli/) |

## Configure and operate

| Reference | What it covers |
| --- | --- |
| [MCP](MCP.md) | Grant lifecycle, observation, safe input, team-access rollout and operator gates |
| [Accounts app](../app/README.md) | Local app development, authentication, database and deployment |
| [Self-hosting](self-hosting.md) | Standalone relay, Worker relay and optional accounts service |
| [Session content](session-content.md) | Passive activity and owner-encrypted excerpts; limits and privacy |
| [Jev supervision](JEV.md) | Optional, explicit model-assisted assessment and its configuration |
| [Game](shell-keep.md) | Current game behavior and where its displayed numbers come from |
| [Separate game deployment](deploy-game.md) | Optional split Worker setup—not required to run the app |
| [Third-party notices](third-party-notices.md) | Asset licenses and attribution |

The latest CLI release, the current source tree, and a particular deployment
can differ. Feature-specific guides describe prerequisites and rollout gates;
they do not assert that an operator has enabled them. See [release notes](https://github.com/TeoSlayer/shell.online/releases)
and the [changelog](../CHANGELOG.md).

## Change the documentation

- `content.json` holds the versioned public guides. Its version must match `package.json`; tagged copies support older-release docs.
- `shared/documentation.ts` defines routes and navigation. The build renders complete, readable HTML using `shared/documentation-view.ts` and `web/documentation.html`. `web/documentation.ts` adds local search, copy buttons and archived-version loading; current guides remain readable without JavaScript.
- Start with what someone needs to do and what they should see. Put protocol detail, architecture and optional features after the common path.
- Keep commands copyable, examples synthetic, and security boundaries explicit. Do not present intended work as a shipped feature.
- Preserve the content schema and optional historical Mermaid diagrams. Run `npm run check` and `npm run build:web` after changing website documentation.

Keep temporary plans, model transcripts, test captures and deployment evidence
outside the repository. Keep reusable regression tests and required fixtures
in their normal source directories. See [Contributing](../.github/CONTRIBUTING.md).
