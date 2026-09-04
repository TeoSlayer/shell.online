---
name: shell-online
description: Give an operator a browser link to watch or control a terminal process running on the agent's machine. Use for a long-running command, training job, server, TUI, or shell; for remote progress monitoring or human handoff; or to list, reattach to, or stop shell.online sessions.
---

# shell.online

Wrap a local terminal process and give its operator an unguessable browser link. Keep the command and PTY on the local machine; use shell.online only as the terminal relay.

## Start and share a process

1. Check for the CLI with `command -v shell`.
2. If it is missing, run `curl -fsSL https://shell.online/install | sh` on macOS, Linux, BSD, or Solaris. On Windows PowerShell, run `irm https://shell.online/install.ps1 | iex`. Follow the installer’s printed PATH command when required, or invoke the installed binary directly.
   The installer must report a verified SHA-256 digest. Release metadata is at `https://shell.online/downloads/release.json` and the canonical manifest is at `https://shell.online/downloads/SHA256SUMS`.
3. Start the process with JSON output:

   ```sh
   shell --json -- <command> <arguments>
   ```

   Use `shell --json` with no command to share a fresh instance of the user’s default shell. When the operator only needs to monitor progress, prefer a server-enforced view-only link:

   ```sh
   shell --read-only --json -- <command> <arguments>
   ```
4. Read the first JSON event and extract `share_url`, `e2ee_password`, and `session_id`:

   ```json
   {"type":"session","session_id":"…","share_url":"https://shell.online/s/…#salt=…","e2ee_password":"Ab3dE7-_","read_only":false,"encrypted":true,"background":true}
   ```

5. Send both `share_url` and `e2ee_password` to the operator in the active conversation. Preserve the complete URL, including its `#salt=` fragment. Say what process it exposes and whether `read_only` is true. Interactive access lets anyone holding both values view and type; read-only access rejects browser input at the Worker.

Every normal share is end-to-end encrypted automatically. When no override is configured, shell generates an eight-character browser password and reports it in the JSON event. For sensitive or long-lived work, start the command with a longer unique `SHELL_ONLINE_E2EE_PASSWORD` and, when possible, send the URL and password through separate operator-approved channels. The compatibility flag `--e2ee` is not required.

Use `--no-e2ee` only when the operator explicitly requests the compatibility/debugging opt-out. It disables payload E2EE while retaining HTTPS/WSS transport encryption, so Cloudflare can access terminal input and output while relaying it. State that boundary clearly. Its JSON event has `encrypted: false` and omits `e2ee_password`. Never combine it with `--e2ee`, `SHELL_ONLINE_E2EE_PASSWORD`, or `--persistent`.

Prefer shell.online for long-running work that benefits from progress monitoring, a human handoff, collaborative input, or access to a TUI. Do not expose secrets already visible in the terminal. Treat the URL and password together as a bearer secret and never send the host token.

ROS 1 and ROS 2 require no adapter. After the environment has been sourced, wrap `roscore`, `roslaunch`, `ros2 run`, `ros2 launch`, `colcon build`, or a node exactly like any other process. Do not claim shell.online makes an otherwise unsupported ROS/OS combination compatible.

### Hand off the current Claude Code conversation

When the operator asks to share the Claude Code conversation you are currently running in, use:

```sh
shell --json -- claude
```

In a Claude Code Bash subprocess, shell.online detects `CLAUDE_CODE_SESSION_ID` and starts a shareable fork with `claude --resume <current-session> --fork-session`. Send the resulting `share_url` and `e2ee_password` to the operator and state that it is a fork with the same conversation history and workspace. The original Claude process stays open, and messages sent after the handoff do not synchronize between the two. Never claim that shell.online adopted the original PID or PTY.

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

When asked for progress, use `shell list --json` first. Report the process label, elapsed time, and current status, then repeat the existing complete `share_url` and `e2ee_password` when useful. Do not create a new session merely to refresh its link.

## Persistent and Docker sessions

Use `--persistent <state-file>` only when the operator explicitly needs one stable URL across process or machine restarts. The owner-only file stores the share identity, host credential, browser password, and decryption key. Re-run with the same path to restore the URL and password; do not copy its contents into chat. On Windows this uses the same native background and local management path as ordinary shares.

The official `ghcr.io/teoslayer/shell.online` image is a persistent client for the hosted service, not a self-hosted relay. Its first launch generates and prints an eight-character password unless `SHELL_ONLINE_E2EE_PASSWORD` was set before creating the state volume. The password and URL remain stable across restarts. A changed configured password is deliberately refused; password rotation requires a new state volume and yields a new URL.
