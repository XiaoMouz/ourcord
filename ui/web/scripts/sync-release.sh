#!/usr/bin/env bash
set -euo pipefail

readonly repo="XiaoMouz/ourcord"
readonly tag="desktop-beta"
# The asset name lives in app/release.ts so the page, this script, and the
# rendered-html test stay in sync.
asset="$(sed -n 's/^export const installerAsset = "\(.*\)";$/\1/p' app/release.ts)"
readonly asset
mac_asset="$(sed -n 's/^export const macInstallerAsset = "\(.*\)";$/\1/p' app/release.ts)"
readonly mac_asset
if [[ -z "$asset" || -z "$mac_asset" ]]; then
  echo "could not extract public installer names from app/release.ts" >&2
  exit 1
fi
readonly output_dir="public/downloads"

command -v gh >/dev/null 2>&1 || {
  echo "gh is required to sync the private release asset" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "Node.js is required to normalize the updater manifest" >&2
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
release_mac_installer="$(
  gh release view "$tag" \
    --repo "$repo" \
    --json assets \
    --jq '[.assets[] | select(.name | endswith(".dmg"))]
          | sort_by(.updatedAt) | last | .name'
)"
release_mac_updater="$(
  gh release view "$tag" \
    --repo "$repo" \
    --json assets \
    --jq '[.assets[] | select(.name | endswith(".app.tar.gz"))]
          | sort_by(.updatedAt) | last | .name'
)"
if [[ -z "$release_installer" || "$release_installer" == "null" ||
      -z "$release_mac_installer" || "$release_mac_installer" == "null" ||
      -z "$release_mac_updater" || "$release_mac_updater" == "null" ]]; then
  echo "release does not contain both Windows and macOS installers" >&2
  exit 1
fi

mkdir -p "$output_dir"
rm -f \
  "$output_dir"/*.exe \
  "$output_dir"/*.exe.sig \
  "$output_dir"/*.dmg \
  "$output_dir"/*.app.tar.gz \
  "$output_dir"/*.app.tar.gz.sig \
  "$output_dir/latest.json"
gh release download "$tag" \
  --repo "$repo" \
  --pattern "$release_installer" \
  --pattern "$release_installer.sig" \
  --pattern "$release_mac_installer" \
  --pattern "$release_mac_updater" \
  --pattern "$release_mac_updater.sig" \
  --pattern "latest.json" \
  --dir "$tmp_dir" \
  --clobber

installer="$tmp_dir/$release_installer"
mac_installer="$tmp_dir/$release_mac_installer"
mac_updater="$tmp_dir/$release_mac_updater"
install -m 0644 "$installer" "$output_dir/$asset"
install -m 0644 "$mac_installer" "$output_dir/$mac_asset"
install -m 0644 "$mac_updater" "$output_dir/OurCord-macOS-arm64.app.tar.gz"

if [[ -s "$installer.sig" ]]; then
  install -m 0644 "$installer.sig" "$output_dir/$asset.sig"
fi
if [[ -s "$mac_updater.sig" ]]; then
  install -m 0644 "$mac_updater.sig" "$output_dir/OurCord-macOS-arm64.app.tar.gz.sig"
fi
if [[ -s "$tmp_dir/latest.json" ]]; then
  install -m 0644 "$tmp_dir/latest.json" "$output_dir/latest.json"
  node - "$output_dir/latest.json" <<'NODE'
const fs = require("node:fs");

const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const windows = manifest.platforms?.["windows-x86_64"];
const macOS = manifest.platforms?.["darwin-aarch64"];
if (!windows || !macOS ||
    typeof windows.signature !== "string" || windows.signature.length === 0 ||
    typeof macOS.signature !== "string" || macOS.signature.length === 0) {
  throw new Error("latest.json does not contain signed Windows and macOS updates");
}
windows.url =
  "https://ourcord.mou.best/downloads/OurCord-Windows-x64-setup.exe";
macOS.url =
  "https://ourcord.mou.best/downloads/OurCord-macOS-arm64.app.tar.gz";
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
fi

test -s "$output_dir/$asset"
test -s "$output_dir/$mac_asset"
