#!/bin/sh
set -eu

config=${SHELL_ONLINE_WRANGLER_CONFIG:-wrangler.production.jsonc}

if [ ! -f "$config" ]; then
  printf 'Production Wrangler config not found: %s\n' "$config" >&2
  exit 1
fi

# A Workers asset deployment replaces the previous manifest. Always rebuild and
# verify the complete download bundle so a web-only deploy cannot remove it.
npm run build
npm run verify:downloads
npx wrangler deploy --config "$config" "$@"
