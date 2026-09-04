#!/bin/sh
set -eu

release_go_toolchain="go1.26.8"
export GOTOOLCHAIN="$release_go_toolchain"

version="${npm_package_version:-$(node -p 'require("./package.json").version')}"
go_version=$(go env GOVERSION)
if [ "$go_version" != "$release_go_toolchain" ]; then
  printf 'Expected release toolchain %s, got %s\n' "$release_go_toolchain" "$go_version" >&2
  exit 1
fi
output_dir="dist/downloads"
mkdir -p "$output_dir"
find "$output_dir" -type f -delete
checksum_manifest="$output_dir/SHA256SUMS"
checksum_manifest_tmp="$output_dir/.SHA256SUMS.tmp"
: > "$checksum_manifest_tmp"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

while IFS="	" read -r artifact target_os target_arch variant; do
  case "$artifact" in ''|'#'*) continue ;; esac
  output="$output_dir/$artifact"
  printf 'Building %-30s %s/%s %s\n' "$artifact" "$target_os" "$target_arch" "$variant"
  case "$variant" in
    GOARM=*)
      GOARM=${variant#GOARM=} CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
        go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=$version" -o "$output" ./cmd/shell
      ;;
    GOMIPS=*)
      GOMIPS=${variant#GOMIPS=} CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
        go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=$version" -o "$output" ./cmd/shell
      ;;
    GOMIPS64=*)
      GOMIPS64=${variant#GOMIPS64=} CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
        go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=$version" -o "$output" ./cmd/shell
      ;;
    -)
      CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
        go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=$version" -o "$output" ./cmd/shell
      ;;
    *)
      printf 'Unknown target variant: %s\n' "$variant" >&2
      exit 1
      ;;
  esac

  checksum=$(sha256_file "$output")
  printf '%s  %s\n' "$checksum" "$artifact" > "$output.sha256"
  printf '%s  %s\n' "$checksum" "$artifact" >> "$checksum_manifest_tmp"
done < scripts/release-targets.tsv

cp public/install "$output_dir/install"
cp public/install.ps1 "$output_dir/install.ps1"
cp public/skill/shell-online/SKILL.md "$output_dir/SKILL.md"
for filename in install install.ps1 SKILL.md; do
  checksum=$(sha256_file "$output_dir/$filename")
  printf '%s  %s\n' "$checksum" "$filename" >> "$checksum_manifest_tmp"
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

release_checksum=$(sha256_file "$release_metadata")
printf '%s  %s\n' "$release_checksum" "$(basename "$release_metadata")" > "$release_metadata.sha256"
printf '%s  %s\n' "$release_checksum" "$(basename "$release_metadata")" >> "$checksum_manifest"

printf 'Release %s checksums:\n' "$version"
cat "$checksum_manifest"
node ./scripts/verify-downloads.mjs "$output_dir"
