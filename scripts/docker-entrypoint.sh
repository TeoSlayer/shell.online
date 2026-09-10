#!/bin/sh
set -eu

state_directory=${SHELL_ONLINE_STATE_DIRECTORY:-/var/lib/shell-online}
state_file="$state_directory/session.json"
password_file="$state_directory/password"
mkdir -p "$state_directory"
chmod 700 "$state_directory"

configured_password=${SHELL_ONLINE_E2EE_PASSWORD:-}
if [ -r "$password_file" ]; then
  stored_password=$(cat "$password_file")
  if [ -n "$configured_password" ] && [ "$configured_password" != "$stored_password" ]; then
    printf '\n  Docker password does not match the persistent session.\n' >&2
    printf '  Restore the original password or start with a new state volume and URL.\n\n' >&2
    exit 64
  fi
  SHELL_ONLINE_E2EE_PASSWORD=$stored_password
else
  SHELL_ONLINE_E2EE_PASSWORD=$configured_password
  if [ -z "$SHELL_ONLINE_E2EE_PASSWORD" ]; then
    SHELL_ONLINE_E2EE_PASSWORD=$(dd if=/dev/urandom bs=6 count=1 2>/dev/null | base64 | tr '+/' '-_' | tr -d '=\n')
  fi
  if printf '%s' "$SHELL_ONLINE_E2EE_PASSWORD" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    printf 'shell.online: Docker password must not contain control characters\n' >&2
    exit 64
  fi
  umask 077
  printf '%s' "$SHELL_ONLINE_E2EE_PASSWORD" > "$password_file"
fi
chmod 600 "$password_file"
export SHELL_ONLINE_E2EE_PASSWORD

printf '\n  Docker password: %s\n' "$SHELL_ONLINE_E2EE_PASSWORD" >&2
printf '  The browser asks for this password; it is never sent to shell.online.\n\n' >&2

exec shell --foreground --persistent "$state_file" "$@"
