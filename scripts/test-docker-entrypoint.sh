#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

fake_bin="$test_root/bin"
capture_directory="$test_root/capture"
state_directory="$test_root/state"
mkdir -p "$fake_bin" "$capture_directory"

cat > "$fake_bin/shell" <<'SCRIPT'
#!/bin/sh
set -eu
printf '%s' "$SHELL_ONLINE_E2EE_PASSWORD" > "$SHELL_ONLINE_TEST_CAPTURE/password"
printf '%s\n' "$@" > "$SHELL_ONLINE_TEST_CAPTURE/arguments"
SCRIPT
chmod 755 "$fake_bin/shell"

run_entrypoint() {
  SHELL_ONLINE_STATE_DIRECTORY="$state_directory" \
  SHELL_ONLINE_TEST_CAPTURE="$capture_directory" \
  PATH="$fake_bin:$PATH" \
    sh "$repository_root/docker/entrypoint.sh" /bin/bash -il >/dev/null 2>"$test_root/stderr"
}

SHELL_ONLINE_E2EE_PASSWORD='correct horse battery staple'
export SHELL_ONLINE_E2EE_PASSWORD
run_entrypoint
test "$(cat "$state_directory/password")" = "$SHELL_ONLINE_E2EE_PASSWORD"
test "$(cat "$capture_directory/password")" = "$SHELL_ONLINE_E2EE_PASSWORD"
grep -q -- '--persistent' "$capture_directory/arguments"

unset SHELL_ONLINE_E2EE_PASSWORD
run_entrypoint
test "$(cat "$capture_directory/password")" = 'correct horse battery staple'

rm -f "$capture_directory/password"
set +e
SHELL_ONLINE_E2EE_PASSWORD='different password' run_entrypoint
mismatch_status=$?
set -e
test "$mismatch_status" -eq 64
test ! -e "$capture_directory/password"
grep -q 'does not match the persistent session' "$test_root/stderr"

generated_state="$test_root/generated-state"
unset SHELL_ONLINE_E2EE_PASSWORD
SHELL_ONLINE_STATE_DIRECTORY="$generated_state" \
SHELL_ONLINE_TEST_CAPTURE="$capture_directory" \
PATH="$fake_bin:$PATH" \
  sh "$repository_root/docker/entrypoint.sh" /bin/bash -il >/dev/null 2>"$test_root/generated-stderr"
generated_password=$(cat "$generated_state/password")
test "${#generated_password}" -eq 8
case "$generated_password" in
  *[!A-Za-z0-9_-]*) exit 1 ;;
esac

echo "docker entrypoint tests passed"
