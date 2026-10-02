# Session summaries

Hover a session in app.shell.online (List or Board view; long-press on touch)
to see a short summary of what it is doing. Summaries are off by default,
owner-only, and opt-in per session:

```sh
shell permissions <session-id> --summaries=true
```

or the **Summaries** switch under *Agent permissions* on the session page.

## When a summary is made

Once each time the session goes idle (about 20 seconds without new output, or
a Claude Code turn ending), and again only after new output. Turning
Summaries on for a session that is already idle shows "No summary yet" until
it prints something new. Only sessions started with a CLI that includes
summaries are covered; restart older sessions to include them.

## What leaves your machine

- **Claude Code sessions:** nothing in plain text. The host reads the
  conversation's own transcript (title and latest assistant reply, never
  thinking or tool output), cleans it to plain text, and encrypts it to your
  account vault key on your machine.
- **Other terminal processes:** the host strips terminal control sequences,
  redacts credential-shaped text, and sends the last 12 KiB of output,
  encrypted, to the shell.online summarizer. It does so only after verifying
  the summarizer's attestation: an Intel TDX Confidential VM running Google's
  production Confidential Space image, a container image on an allowlist
  signed by the shell.online release key, and an encryption key generated
  inside that instance. The summarizer runs Qwen3-4B-Instruct with no tools
  and no internet access, and encrypts the summary to your vault key before
  it leaves the enclave.

The account service stores only ciphertext. Your browser decrypts summaries
after you unlock your vault.

## Trust boundary

shell.online operators, Google operators and the load balancer cannot read
your terminal output or summaries. You still trust: Intel TDX and Google's
attestation service; the holder of the release key, who decides which
summarizer images hosts accept; and the shell CLI and web app you run. See
the summarizer's SECURITY.md for the full model, including prompt-injection
defences.

Summaries are automated and may be wrong. They are shown as plain text with
no links, and should never be treated as instructions.

## Turning it off

Switching Summaries off deletes the stored summary and stops capture.
