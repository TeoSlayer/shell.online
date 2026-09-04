#!/bin/sh
set -eu

repository_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
release_targets=$repository_root/scripts/release-targets.tsv
qemu_targets=$repository_root/scripts/qemu-linux-targets.tsv

test_root=$(mktemp -d "${TMPDIR:-/tmp}/shell-online-qemu-test.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

release_linux=$test_root/release-linux
qemu_linux=$test_root/qemu-linux
awk -F '\t' '$1 !~ /^#/ && $2 == "linux" { print $1 }' "$release_targets" | sort > "$release_linux"
awk -F '\t' '$1 !~ /^#/ { print $1 }' "$qemu_targets" | sort > "$qemu_linux"
if ! cmp -s "$release_linux" "$qemu_linux"; then
  printf 'QEMU manifest must cover every Linux release artifact exactly once.\n' >&2
  diff -u "$release_linux" "$qemu_linux" >&2 || true
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  printf 'QEMU manifest covers %s Linux release artifacts.\n' "$(wc -l < "$qemu_linux" | tr -d ' ')"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  set -- $(cat "$qemu_linux")
fi

run_target() {
  requested=$1
  row=$(awk -F '\t' -v artifact="shell-linux-$requested" '$1 == artifact { print; exit }' "$qemu_targets")
  if [ -z "$row" ]; then
    printf 'Unknown QEMU target: %s\n' "$requested" >&2
    exit 2
  fi

  artifact=$(printf '%s\n' "$row" | cut -f1)
  target_arch=$(printf '%s\n' "$row" | cut -f2)
  variant=$(printf '%s\n' "$row" | cut -f3)
  emulator=$(printf '%s\n' "$row" | cut -f4)

  if ! command -v "$emulator" >/dev/null 2>&1; then
    printf 'Required emulator is missing: %s\n' "$emulator" >&2
    exit 1
  fi

  unset GOARM GOMIPS GOMIPS64
  case "$variant" in
    GOARM=*) export GOARM=${variant#GOARM=} ;;
    GOMIPS=*) export GOMIPS=${variant#GOMIPS=} ;;
    GOMIPS64=*) export GOMIPS64=${variant#GOMIPS64=} ;;
    -) ;;
    *)
      printf 'Unsupported QEMU target variant: %s\n' "$variant" >&2
      exit 1
      ;;
  esac

  export CGO_ENABLED=0 GOOS=linux GOARCH=$target_arch
  output=$test_root/$artifact

  printf '\n==> QEMU runtime test: %s via %s\n' "$artifact" "$emulator"
  (
    cd "$repository_root"
    go test -count=1 -timeout=2m -exec "$emulator" ./...
    go build -buildvcs=false -trimpath -ldflags='-s -w -X main.version=qemu-test' -o "$output" ./cmd/shell
  )

  version=$($emulator "$output" --version)
  if [ "$version" != "shell qemu-test" ]; then
    printf '%s --version returned %s\n' "$artifact" "$version" >&2
    exit 1
  fi
  help=$($emulator "$output" help)
  case "$help" in
    *'shell.online'*'shell attach <ID>'*'shell kill <ID>'*) ;;
    *)
      printf '%s did not render the expected CLI help.\n' "$artifact" >&2
      exit 1
      ;;
  esac
  printf 'Passed %s: full Go suite, PTY integration, executable startup, and CLI help.\n' "$artifact"
}

for target in "$@"; do
  run_target "$target"
done
