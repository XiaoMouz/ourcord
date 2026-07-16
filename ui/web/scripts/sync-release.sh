#!/usr/bin/env bash
set -euo pipefail

readonly repo="XiaoMouz/ourcord"
readonly tag="desktop-beta"
readonly asset="OurCord_0.1.0-beta.1_x64-setup.exe"
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
