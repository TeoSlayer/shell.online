#!/bin/sh
set -eu

version="${npm_package_version:-$(node -p 'require("./package.json").version')}"
go_version=$(go env GOVERSION)
output_dir="dist/downloads"
mkdir -p "$output_dir"
checksum_manifest="$output_dir/SHA256SUMS"
checksum_manifest_tmp="$output_dir/.SHA256SUMS.tmp"
: > "$checksum_manifest_tmp"

for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
  target_os=${target%/*}
  target_arch=${target#*/}
  output="$output_dir/shell-$target_os-$target_arch"
  printf 'Building %s/%s\n' "$target_os" "$target_arch"
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
    go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=$version" -o "$output" ./cmd/shell

  if command -v sha256sum >/dev/null 2>&1; then
    checksum=$(sha256sum "$output" | awk '{print $1}')
  else
    checksum=$(shasum -a 256 "$output" | awk '{print $1}')
  fi
  printf '%s  %s\n' "$checksum" "$(basename "$output")" > "$output.sha256"
  printf '%s  %s\n' "$checksum" "$(basename "$output")" >> "$checksum_manifest_tmp"
done

mv "$checksum_manifest_tmp" "$checksum_manifest"

release_metadata="$output_dir/release.json"
release_metadata_tmp="$output_dir/.release.json.tmp"
{
  printf '{\n'
  printf '  "version": "%s",\n' "$version"
  printf '  "go_version": "%s",\n' "$go_version"
  printf '  "algorithm": "sha256",\n'
  printf '  "artifacts": {\n'
  first=1
  while read -r checksum filename; do
    if [ "$first" -eq 0 ]; then
      printf ',\n'
    fi
    printf '    "%s": "%s"' "$filename" "$checksum"
    first=0
  done < "$checksum_manifest"
  printf '\n  }\n'
  printf '}\n'
} > "$release_metadata_tmp"
mv "$release_metadata_tmp" "$release_metadata"

printf 'Release %s checksums:\n' "$version"
cat "$checksum_manifest"
