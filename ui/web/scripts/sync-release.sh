#!/usr/bin/env bash
set -euo pipefail

readonly repo="XiaoMouz/ourcord"
readonly tag="desktop-beta"
# The asset name lives in app/release.ts so the page, this script, and the
# rendered-html test stay in sync.
asset="$(sed -n 's/^export const installerAsset = "\(.*\)";$/\1/p' app/release.ts)"
readonly asset
if [[ -z "$asset" ]]; then
  echo "could not extract installerAsset from app/release.ts" >&2
  exit 1
fi
readonly output_dir="public/downloads"

command -v gh >/dev/null 2>&1 || {
  echo "gh is required to sync the private release asset" >&2
  exit 1
}

mkdir -p "$output_dir"
gh release download "$tag" \
  --repo "$repo" \
  --pattern "$asset" \
  --dir "$output_dir" \
  --clobber

test -s "$output_dir/$asset"
