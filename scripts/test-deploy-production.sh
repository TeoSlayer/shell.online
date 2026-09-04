#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/shell-online-deploy-test.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

fake_bin="$test_root/bin"
command_log="$test_root/commands"
config="$test_root/wrangler.production.jsonc"
mkdir -p "$fake_bin"
: > "$config"

cat > "$fake_bin/npm" <<'SCRIPT'
#!/bin/sh
printf 'npm %s\n' "$*" >> "$SHELL_ONLINE_TEST_COMMAND_LOG"
if [ "${SHELL_ONLINE_TEST_VERIFY_FAIL:-0}" = "1" ] && [ "$*" = "run verify:downloads" ]; then
  exit 42
fi
SCRIPT

cat > "$fake_bin/npx" <<'SCRIPT'
#!/bin/sh
printf 'npx %s\n' "$*" >> "$SHELL_ONLINE_TEST_COMMAND_LOG"
SCRIPT

chmod 755 "$fake_bin/npm" "$fake_bin/npx"

SHELL_ONLINE_TEST_COMMAND_LOG="$command_log" \
SHELL_ONLINE_WRANGLER_CONFIG="$config" \
PATH="$fake_bin:$PATH" \
  sh "$repository_root/scripts/deploy-production.sh"

expected=$(printf 'npm run build\nnpm run verify:downloads\nnpx wrangler deploy --config %s\n' "$config")
test "$(cat "$command_log")" = "$expected"

: > "$command_log"
set +e
SHELL_ONLINE_TEST_VERIFY_FAIL=1 \
SHELL_ONLINE_TEST_COMMAND_LOG="$command_log" \
SHELL_ONLINE_WRANGLER_CONFIG="$config" \
PATH="$fake_bin:$PATH" \
  sh "$repository_root/scripts/deploy-production.sh"
verification_status=$?
set -e
test "$verification_status" -eq 42
test "$(cat "$command_log")" = "$(printf 'npm run build\nnpm run verify:downloads')"

: > "$command_log"
if SHELL_ONLINE_TEST_COMMAND_LOG="$command_log" \
  SHELL_ONLINE_WRANGLER_CONFIG="$test_root/missing.jsonc" \
  PATH="$fake_bin:$PATH" \
  sh "$repository_root/scripts/deploy-production.sh" 2>/dev/null; then
  printf 'Deployment unexpectedly accepted a missing Wrangler config.\n' >&2
  exit 1
fi
test ! -s "$command_log"

echo "production deployment guard tests passed"
