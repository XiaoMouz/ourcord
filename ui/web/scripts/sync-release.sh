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

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

release_installer="$(
  gh release view "$tag" \
    --repo "$repo" \
    --json assets \
    --jq '[.assets[] | select(.name | endswith(".exe"))]
          | sort_by(.updatedAt) | last | .name'
)"
if [[ -z "$release_installer" || "$release_installer" == "null" ]]; then
  echo "release does not contain a Windows installer" >&2
  exit 1
fi

mkdir -p "$output_dir"
gh release download "$tag" \
  --repo "$repo" \
  --pattern "$release_installer" \
  --pattern "$release_installer.sig" \
  --pattern "latest.json" \
  --dir "$tmp_dir" \
  --clobber

installer="$tmp_dir/$release_installer"
install -m 0644 "$installer" "$output_dir/$asset"

if [[ -s "$installer.sig" ]]; then
  install -m 0644 "$installer.sig" "$output_dir/$asset.sig"
fi
if [[ -s "$tmp_dir/latest.json" ]]; then
  install -m 0644 "$tmp_dir/latest.json" "$output_dir/latest.json"
  node - "$output_dir/latest.json" <<'NODE'
const fs = require("node:fs");

const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const windows = manifest.platforms?.["windows-x86_64"];
if (!windows || typeof windows.signature !== "string" || windows.signature.length === 0) {
  throw new Error("latest.json does not contain a signed windows-x86_64 update");
}
windows.url =
  "https://ourcord.mou.best/downloads/OurCord-Windows-x64-setup.exe";
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
fi

test -s "$output_dir/$asset"
