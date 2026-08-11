import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", root), "utf8");
const releaseSource = readFileSync(new URL("ui/web/app/release.ts", root), "utf8");
const syncScript = readFileSync(
  new URL("ui/web/scripts/sync-release.sh", root),
  "utf8",
);

const installerAsset = releaseSource.match(
  /^export const installerAsset = "(.+)";$/m,
)?.[1];
const macInstallerAsset = releaseSource.match(
  /^export const macInstallerAsset = "(.+)";$/m,
)?.[1];

test("uses a version-independent public installer URL", () => {
  assert.equal(installerAsset, "OurCord-Windows-x64-setup.exe");
  assert.doesNotMatch(installerAsset, /\d+\.\d+\.\d+/);
  assert.equal(macInstallerAsset, "OurCord-macOS-arm64.dmg");
  assert.doesNotMatch(macInstallerAsset, /\d+\.\d+\.\d+/);
});

test("desktop release hands the installer to the website deployment", () => {
  assert.match(workflow, /name:\s*website-downloads/);
  assert.match(workflow, /needs:\s*\[windows-x64, macos-arm64\]/);
  assert.match(workflow, /runs-on:\s*macos-15/);
  assert.match(workflow, /tauri bundle --bundles app,dmg/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.match(workflow, /actions\/download-artifact@/);
  assert.match(workflow, /wrangler deploy --config wrangler\.apex\.jsonc/);
});

test("updater and release manifest use the public website", () => {
  assert.match(
    workflow,
    /https:\/\/ourcord\.mou\.best\/downloads\/latest\.json/,
  );
  assert.match(
    workflow,
    /https:\/\/ourcord\.mou\.best\/downloads\/OurCord-Windows-x64-setup\.exe/,
  );
  assert.match(
    workflow,
    /https:\/\/ourcord\.mou\.best\/downloads\/OurCord-macOS-arm64\.app\.tar\.gz/,
  );
  assert.match(workflow, /"darwin-aarch64"/);
  assert.match(
    syncScript,
    /https:\/\/ourcord\.mou\.best\/downloads\/OurCord-Windows-x64-setup\.exe/,
  );
});

test("deployment verifies the public installer checksum", () => {
  assert.match(workflow, /sha256sum "\$file"/);
  assert.match(workflow, /sha256sum "\$downloaded"/);
  assert.match(workflow, /installer checksum mismatch/);
  assert.match(workflow, /website metadata did not propagate/);
  assert.match(workflow, /OurCord-macOS-arm64\.dmg/);
});
