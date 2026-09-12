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
cd "$repository_root"

# A Workers asset deployment replaces the previous manifest. Always rebuild and
# verify the complete download bundle so a web-only deploy cannot remove it.
npm run build
npm run verify:downloads

# Stage only after verification. The deployment guard runs as part of the build
# and must not mistake this outer deploy's temporary file for leaked config.
deployment_config=$config
if [ "$config_directory" != "$repository_root" ]; then
  # BSD mktemp (macOS) requires the X run at the end of the template. Reserve
  # that path first, then add the suffix expected by Wrangler and the guard.
  deployment_base=$(mktemp "$repository_root/.wrangler.production.XXXXXX")
  deployment_config="$deployment_base.jsonc"
  mv "$deployment_base" "$deployment_config"
  cp "$config" "$deployment_config"
  chmod 600 "$deployment_config"
  trap 'rm -f -- "$deployment_config"' EXIT HUP INT TERM
fi
npx wrangler deploy --config "$deployment_config" "$@"
