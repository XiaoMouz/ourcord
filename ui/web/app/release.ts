// Single source of truth for the public Windows installer asset name.
// scripts/sync-release.sh and tests/rendered-html.test.mjs extract the value
// from this file textually — keep the `installerAsset` line a plain string
// literal on one line.
export const installerAsset = "OurCord_0.1.0-beta.1_x64-setup.exe";
export const releaseUrl = `/downloads/${installerAsset}`;
