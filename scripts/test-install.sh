#!/bin/sh
set -eu

test_root=$(mktemp -d "${TMPDIR:-/tmp}/shell-online-install-test.XXXXXX")
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

installer=$(CDPATH= cd "$(dirname "$0")/.." && pwd)/public/install
downloads=$test_root/downloads
mkdir -p "$downloads"

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *)
    printf 'Skipping installer integration test on unsupported host OS.\n'
    exit 0
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) architecture=arm64 ;;
  x86_64|amd64) architecture=amd64 ;;
  *)
    printf 'Skipping installer integration test on unsupported host architecture.\n'
    exit 0
    ;;
esac

binary_name=shell-$platform-$architecture
printf '%s\n' '#!/bin/sh' 'printf "shell 9.9.9\\n"' > "$downloads/$binary_name"
chmod 0755 "$downloads/$binary_name"

if command -v sha256sum >/dev/null 2>&1; then
  checksum=$(sha256sum "$downloads/$binary_name" | awk '{print $1}')
else
  checksum=$(shasum -a 256 "$downloads/$binary_name" | awk '{print $1}')
fi
printf '%s  %s\n' "$checksum" "$binary_name" > "$downloads/SHA256SUMS"
base_url=file://$test_root

assert_contains() {
  haystack=$1
  needle=$2
  case "$haystack" in
    *"$needle"*) ;;
    *)
      printf 'Expected output to contain: %s\nOutput was:\n%s\n' "$needle" "$haystack" >&2
      exit 1
      ;;
  esac
}

run_installer() {
  destination=$1
  shift
  SHELL_ONLINE_BASE_URL=$base_url \
    SHELL_ONLINE_INSTALL_DIR=$destination \
    SHELL=/bin/zsh \
    "$@" sh "$installer" 2>&1
}

install_dir=$test_root/install/bin
output=$(run_installer "$install_dir" env)
test -x "$install_dir/shell"
test "$("$install_dir/shell" --version)" = "shell 9.9.9"
assert_contains "$output" "Installed shell to $install_dir/shell"
assert_contains "$output" "Verified SHA-256: $checksum"
assert_contains "$output" "$install_dir is not on your PATH yet"

printf '%s\n' '#!/bin/sh' 'printf "shell 0.0.1\\n"' > "$install_dir/shell"
chmod 0755 "$install_dir/shell"
output=$(run_installer "$install_dir" env)
assert_contains "$output" "Updating shell 0.0.1 at $install_dir/shell"
test "$("$install_dir/shell" --version)" = "shell 9.9.9"

bad_downloads=$test_root/bad/downloads
mkdir -p "$bad_downloads"
cp "$downloads/$binary_name" "$bad_downloads/$binary_name"
printf '%064d  %s\n' 0 "$binary_name" > "$bad_downloads/SHA256SUMS"
bad_install=$test_root/bad-install
if output=$(SHELL_ONLINE_BASE_URL=file://$test_root/bad \
  SHELL_ONLINE_INSTALL_DIR=$bad_install sh "$installer" 2>&1); then
  printf 'Checksum mismatch unexpectedly succeeded.\n' >&2
  exit 1
fi
assert_contains "$output" "downloaded binary failed checksum verification"
test ! -e "$bad_install/shell"

if output=$(SHELL_ONLINE_INSTALL_DIR=relative/path sh "$installer" 2>&1); then
  printf 'Relative install directory unexpectedly succeeded.\n' >&2
  exit 1
fi
assert_contains "$output" "install directory must be absolute"

mock_bin=$test_root/mock-bin
mkdir -p "$mock_bin"
printf '%s\n' '#!/bin/sh' 'case "$1" in' '  -s) printf "Haiku\\n" ;;' '  *) printf "arm64\\n" ;;' 'esac' > "$mock_bin/uname"
chmod 0755 "$mock_bin/uname"
if output=$(PATH=$mock_bin:$PATH sh "$installer" 2>&1); then
  printf 'Unsupported operating system unexpectedly succeeded.\n' >&2
  exit 1
fi
assert_contains "$output" "unsupported operating system: Haiku"

not_a_directory=$test_root/not-a-directory
: > "$not_a_directory"
if output=$(TMPDIR=$not_a_directory SHELL_ONLINE_INSTALL_DIR=$test_root/unused sh "$installer" 2>&1); then
  printf 'Invalid temporary directory unexpectedly succeeded.\n' >&2
  exit 1
fi
assert_contains "$output" "temporary directory is not writable"

shadow_dir=$test_root/shadow
shadow_install=$test_root/shadow-install
mkdir -p "$shadow_dir"
printf '%s\n' '#!/bin/sh' 'printf "shell 0.1.0\\n"' > "$shadow_dir/shell"
chmod 0755 "$shadow_dir/shell"
output=$(PATH=$shadow_dir:$PATH run_installer "$shadow_install" env)
assert_contains "$output" "Warning: shell currently resolves to $shadow_dir/shell"

printf 'Installer integration scenarios passed.\n'
