#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_input=${SHELL_ONLINE_WRANGLER_CONFIG:-wrangler.production.jsonc}
case "$config_input" in
  /*) config=$config_input ;;
  *) config=$(pwd)/$config_input ;;
esac

if [ ! -f "$config" ]; then
  printf 'Production Wrangler config not found: %s\n' "$config" >&2
  exit 1
fi

# Wrangler resolves `main` and `assets.directory` beside its config file. A
# private config kept in another checkout would otherwise deploy that other
# checkout while this script builds the current one. Stage only the config
# beside this source tree, with owner-only permissions, and remove it on exit.
config_directory=$(CDPATH= cd -- "$(dirname -- "$config")" && pwd)
deployment_config=$config
if [ "$config_directory" != "$repository_root" ]; then
  deployment_config=$(mktemp "$repository_root/.wrangler.production.XXXXXX.jsonc")
  cp "$config" "$deployment_config"
  chmod 600 "$deployment_config"
  trap 'rm -f -- "$deployment_config"' EXIT HUP INT TERM
fi

cd "$repository_root"

# A Workers asset deployment replaces the previous manifest. Always rebuild and
# verify the complete download bundle so a web-only deploy cannot remove it.
npm run build
npm run verify:downloads
npx wrangler deploy --config "$deployment_config" "$@"
