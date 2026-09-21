# MCP observation and input

Introduced in v0.21.0, MCP extends the relay and Go host. Input is off by default;
deploying the code does not enable control without the operator gate below.
The hosted shell.online service enabled that gate for v0.21.0 on 2026-09-21 after
matching-build staging verification. Hosts must still explicitly issue control grants.

The MCP endpoint is `https://shell.online/mcp`. The Go host owns the PTY; the Worker/DO
authenticates a scoped bearer and handles the MCP request. The browser link/password is
not the MCP credential. A host-authorized issuance returns a separate opaque bearer once.

## Operator workflow

1. Start the target in a least-privilege workspace with `shell --json -- <agent-command>`.
2. Run `shell mcp grant <session-id> <label> observe 900` or `control 900`.
3. Supply endpoint and bearer through the MCP client's secret/environment mechanism.
4. Inspect a fresh screen, issue one intended input, then verify the target's result.
5. `shell mcp revoke-all <session-id>` removes MCP access without removing browser access.
   `shell kill -- <session-id>` stops that target; never use `kill --all` for a test cleanup.

Quote labels containing spaces, for example `shell mcp grant <session-id> "My Agent" observe 900`.
Labels are data, not permission fields: the local command encodes the label, scope and lifetime
separately. Labels may be empty or contain Unicode; control characters and labels over 256 UTF-8
bytes are rejected. The service still bounds the displayed label. A lifetime must be a non-negative
whole number of seconds; omitted or `0` selects the preset default. Server-side lifetime caps still apply.

The v0.21.1 CLI uses a versioned local grant request and deliberately does not downgrade it.
A host process started with v0.21.0 does not understand this request: update and restart that
session's shell host when safe before issuing a new grant. Updating the CLI binary alone does
not replace a running host. Listing and revoking existing grants remain available; no target
is automatically stopped or restarted. New hosts still accept well-formed legacy simple-label
requests, but reject extra arguments and malformed lifetimes.

Treat share links, browser passwords, bearer files and raw request/tail logs as credentials.
Store any necessary local credential file owner-only, outside the repository. Grants expire
at a fixed time and do not renew on use. Create a new grant deliberately when needed.

## Supported surface

| Tool | Authority | Meaning |
| --- | --- | --- |
| shell_status | observe | Bounded state, not a transcript or credential |
| shell_screen | observe | Current rendered terminal grid |
| shell_output | observe | Bounded sanitized output with epoch/offset cursor |
| shell_wait | observe | Wait for output/pattern, at most 45 seconds; cancellable |
| shell_send | input | 1–8192 UTF-8 bytes, optional Enter, required UUID-v4 operation_id |

The `control` preset contains observe + input. `shell_key` and `shell_interrupt` are not
implemented; no raw escape/control-byte workaround is allowed. `--read-only` denies input.
Unknown fields and unsafe control characters are rejected. A compatible Go host and enabled
operator gate are required for shell_send to appear in the catalog.

## Delivery and retries

Use one operation ID per intended submission. Same ID + arguments returns the stored result
without resending; changing arguments under the same ID is a conflict. Claims are durable and
bounded; capacity exhaustion refuses new operations instead of forgetting live replay protection.
Reconstruction converts orphaned claims to delivery_uncertain. A unique dispatch token binds
the host acknowledgement to that specific send. Human input outranks MCP; rejected input is
not queued. Revocation, run changes and human activity are rechecked after asynchronous work.

`delivered` confirms the complete PTY write, not target-agent completion. `delivery_uncertain`
must not cause blind resubmission with a new ID. Pre-claim `busy` may be retried with the same ID;
post-claim human veto remains uncertain and consumes the ID. Independently verify work via
the screen and intended artifact. A wait timeout/missed pattern does not prove delivery failed.
Obtain the cursor before the event you want to wait for, and inspect reset/epoch/reason fields.

## Trust boundary and limits

The v0.22.0 app pulse and owner-encrypted response excerpts are separate from
MCP observation and control. Pulse inspects output already received by an open
authorized browser pane. The excerpt publisher reads existing metadata for an
explicitly resumed OpenCode conversation and seals it to the owner's vault; it
does not use an MCP grant, send terminal input, or call a model. Neither feature
proves agent completion or gives a teammate access. See
[session content and pulse](session-content.md) for consent and delivery limits.

MCP explicitly authorizes server-side, in-memory decryption using the host-supplied frame key.
Controllers receive plaintext. MCP stores no plaintext terminal content, key or bearer;
its durable records contain grant metadata, bearer hashes and operation fingerprints/outcomes.
The relay's existing offline-screen cache is separate: it stores ciphertext for E2EE sessions,
but may contain plaintext for sessions explicitly started with --no-e2ee. Browser
disclosure lasts for the full grant lifetime, separately from recent-agent presence.
Terminal output is untrusted data, never permission to override controller instructions.

The original staging implementation exercised Codex and OpenCode observation and OpenCode/GH200
target control. The upstream port uses new opcodes and requires matching host/relay builds.
On 2026-09-21, matching v0.21.0 builds passed an isolated 16-check canary on deployed staging
and production: encrypted observation, acknowledged input, independent command completion,
duplicate suppression, wait cancellation, password rotation, fresh-grant access, revocation
and verified cleanup. This used a synthetic shell, not a new model-backed client-matrix run.
Claude model-backed behavior remains unverified. Idle live-grant hibernation is not claimed (timers prevent it);
reconstruction and duplicate recovery have deterministic tests. Normal runtime quotas apply;
concurrency saturation tests may be inconclusive and are not represented as passed.

## Game request feed (v0.22.0+)

The game can show recent tool requests into your own sessions. A matching relay
and updated running Go host report only a random request ID, allowlisted tool,
start/settlement time and outcome. Reports travel over the host connection and
its linked-account authentication, not plaintext viewer presence. The account
service checks the originating device and current session ownership. The game
uses an authenticated, owner-only endpoint; being a teammate or seeing a session
listing does not grant access to this feed.

Migration `021_mcp_flows.sql` supplies shared storage across account-service
instances. Events are served for at most two minutes, with bounded per-owner and
global capacity; expiry cleanup also runs through the existing scheduled purge.
The host queue is bounded and best-effort: failures drop observations, so the feed
is not a durable audit log and a missing completion is not evidence of success.

Sources currently appear as **External MCP client**. Neither a bearer label nor
an input acknowledgement verifies which agent called, or that its requested task
finished. Verified agent-to-agent attribution and team-wide delivery are not
implemented. The feed contains no tool arguments, prompts, terminal output,
response content, credentials or grant labels.

## Deployment and compatibility

Use the existing full production release pipeline (`npm run deploy:production`), which builds
and verifies the complete download bundle before upload. Do not replace it with a web-only deploy.
Private configs and credentials remain gitignored. Configure the two independent ECDH JWK secrets
MCP_ROUTE_KEY and MCP_FRAME_KEY, the MCP_LIMITER binding, /mcp in run_worker_first, and the
enable_request_signal compatibility flag (see wrangler.example.jsonc). Keep MCP_CONTROL_ENABLED
at "0" until matching builds have passed a bounded staging send/ack/retry/revoke canary;
only "1" or "true" enables input. Staging uses distinct Worker, route, limiter and analytics targets.

File transfer retains opcodes 0x0A/0x0B. MCP Send/SendAck use 0x0C/0x0D and envelope-v2
direction/sequence authentication. The earlier unreleased draft used conflicting opcodes and
must not be mixed with these builds. Older released hosts remain observe-only. Live password
rotation revokes every existing MCP grant and cancels pending work; issue fresh grants afterward.

The native MCP grant channel is separate from Refstream's browser-mediated Connect agent
invitation. Do not interchange their credentials or assume they expose the same tools.

Run npm run check, npm --prefix app test, and go test -race ./... before merging changes.
For a local real-runtime canary, run `npm run build:web && node scripts/test-mcp-local.mjs`.
It starts isolated workerd and Go processes, checks encrypted send/retry/rotation/revocation,
and verifies cleanup; it neither deploys nor starts a model.
The bounded staging harness is scripts/staging-harness/run.mjs; use --help for cases/options.
It creates synthetic sessions, scans evidence for secrets and verifies cleanup. INCONCLUSIVE
means a cap was not exercised, not that it passed. Keep raw Wrangler tails out of evidence.

## Incident response and rotation

For a stolen bearer, revoke it or revoke all grants for that session. Stop the target if its
actions are unsafe. Revocation cannot undo prior actions or delete output held by controllers.
An operator can disable the control gate and redeploy while keeping observation/browser access.
For key compromise, disable control, stop issuance operationally, revoke affected grants, and
replace independent route/frame keys in managed secrets; issue fresh grants afterward.
The current deployed resolver supports one route key and one frame key, not overlapping
keyrings. Rotation invalidates old credentials; zero-downtime overlap is not claimed.
Never roll back to a pre-claims writer and re-enable writes with old grants.
