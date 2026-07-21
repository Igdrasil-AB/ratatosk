#!/usr/bin/env bash
set -euo pipefail

tag="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
artifact_dir="${STUDIO_ARTIFACT_DIR:-artifacts}"
gh_cli="${GH_CLI:-gh}"

shopt -s nullglob
archives=("$artifact_dir"/ratatosk-studio-*.zip)
checksums=("$artifact_dir"/ratatosk-studio-*.zip.sha256)
if [[ ${#archives[@]} -ne 1 ]]; then
  echo "expected exactly one Studio ZIP in $artifact_dir" >&2
  exit 1
fi
archive="${archives[0]}"
checksum="$archive.sha256"
if [[ ${#checksums[@]} -ne 1 || "${checksums[0]}" != "$checksum" ]]; then
  echo "expected exactly one matching Studio checksum for $archive" >&2
  exit 1
fi
(cd "$artifact_dir" && shasum -a 256 -c "$(basename "$checksum")")

if "$gh_cli" release view "$tag" >/dev/null 2>&1; then
  existing_dir="$(mktemp -d)"
  trap 'rm -rf "$existing_dir"' EXIT
  "$gh_cli" release download "$tag" \
    --dir "$existing_dir" \
    --pattern "$(basename "$archive")" \
    --pattern "$(basename "$checksum")"
  cmp -- "$archive" "$existing_dir/$(basename "$archive")"
  cmp -- "$checksum" "$existing_dir/$(basename "$checksum")"
  echo "Existing release $tag contains the exact reviewed Studio artifacts."
else
  "$gh_cli" release create "$tag" "$archive" "$checksum" \
    --verify-tag \
    --title "Ratatosk Studio $tag" \
    --generate-notes
fi
