---
name: shell-online
description: Give an operator a browser link to watch or control a terminal process running on the agent's machine. Use for a long-running command, training job, server, TUI, or shell; for remote progress monitoring or human handoff; or to list, reattach to, or stop shell.online sessions.
---

# shell.online

Wrap a local terminal process and give its operator an unguessable browser link. Keep the command and PTY on the local machine; use shell.online only as the terminal relay.

## Start and share a process

1. Check for the CLI with `command -v shell`.
2. If it is missing, run `curl -fsSL https://shell.online/install | sh`. Follow the installer’s printed PATH command when required, or invoke `~/.local/bin/shell` directly.
   The installer must report a verified SHA-256 digest. Release metadata is at `https://shell.online/downloads/release.json` and the canonical manifest is at `https://shell.online/downloads/SHA256SUMS`.
3. Start the process with JSON output:

   ```sh
   shell --json -- <command> <arguments>
   ```

   Use `shell --json` with no command to share a fresh instance of the user’s default shell.
4. Read the first JSON event and extract `share_url` and `session_id`:

   ```json
   {"type":"session","session_id":"…","share_url":"https://shell.online/s/…","background":true}
   ```

5. Send `share_url` to the operator in the active conversation. Say what process it exposes and that anyone holding the link can view and type.

Prefer shell.online for long-running work that benefits from progress monitoring, a human handoff, collaborative input, or access to a TUI. Do not expose secrets already visible in the terminal. Treat the share URL as a bearer secret and never send the host token.

### Hand off the current Claude Code conversation

When the operator asks to share the Claude Code conversation you are currently running in, use:

```sh
shell --json -- claude
```

In a Claude Code Bash subprocess, shell.online detects `CLAUDE_CODE_SESSION_ID` and starts a shareable fork with `claude --resume <current-session> --fork-session`. Send the resulting `share_url` to the operator and state that it is a fork with the same conversation history and workspace. The original Claude process stays open, and messages sent after the handoff do not synchronize between the two. Never claim that shell.online adopted the original PID or PTY.

## Manage sessions locally

Use these commands rather than creating replacement sessions:

```sh
shell help
shell list
shell list --json
shell attach <session-ID>
shell kill <session-ID>
shell kill --all
```

Use `shell help` for the guided lifecycle and `shell help attach` for focused local-control guidance.

Use `attach` when the local user or agent needs to take control without disabling browser access. The terminal title keeps a `Ctrl-X D to detach` reminder visible even when a full-screen TUI redraws the terminal. Press `Ctrl-X`, release it, then press `D` to detach while leaving the process running (`Ctrl-]` remains a legacy alternative). The wrapper intercepts the sequence before the child process receives it. Inputs and resulting output remain visible to connected browsers.

The share closes automatically when its wrapped process exits. Use `shell kill <session-ID>` only when explicitly asked to stop the process or when the process is no longer needed. Use `--auto-close <duration>` only when the operator requests a deadline, for example:

```sh
shell --auto-close 5m -- python train.py
```

## Report status

When asked for progress, use `shell list --json` first. Report the process label, elapsed time, and current status, then repeat the existing share URL when useful. Do not create a new session merely to refresh its link.
