#!/bin/sh
set -eu

state_directory=${SHELL_ONLINE_STATE_DIRECTORY:-/var/lib/shell-online}
state_file="$state_directory/session.json"
password_file="$state_directory/password"
mkdir -p "$state_directory"
chmod 700 "$state_directory"

if [ -z "${SHELL_ONLINE_E2EE_PASSWORD:-}" ]; then
  if [ -r "$password_file" ]; then
    SHELL_ONLINE_E2EE_PASSWORD=$(sed -n '1p' "$password_file")
  else
    umask 077
    SHELL_ONLINE_E2EE_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
    printf '%s\n' "$SHELL_ONLINE_E2EE_PASSWORD" > "$password_file"
  fi
fi
export SHELL_ONLINE_E2EE_PASSWORD

printf '\n  Docker password: %s\n' "$SHELL_ONLINE_E2EE_PASSWORD" >&2
printf '  The browser asks for this password; it is never sent to shell.online.\n\n' >&2

exec shell --foreground --e2ee --persistent "$state_file" "$@"
