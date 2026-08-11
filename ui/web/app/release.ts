// Stable public filenames. The release workflow replaces their contents on
// every successful beta publication, so links never depend on an app version.
// scripts/sync-release.sh extracts these values textually; keep each assignment
// as a plain string literal on one line.
export const installerAsset = "OurCord-Windows-x64-setup.exe";
export const macInstallerAsset = "OurCord-macOS-arm64.dmg";
export const windowsReleaseUrl = `/downloads/${installerAsset}`;
export const macReleaseUrl = `/downloads/${macInstallerAsset}`;
