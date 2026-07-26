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

test("uses a version-independent public installer URL", () => {
  assert.equal(installerAsset, "OurCord-Windows-x64-setup.exe");
  assert.doesNotMatch(installerAsset, /\d+\.\d+\.\d+/);
});

test("desktop release hands the installer to the website deployment", () => {
  assert.match(workflow, /name:\s*website-downloads/);
  assert.match(workflow, /needs:\s*windows-x64/);
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
    syncScript,
    /https:\/\/ourcord\.mou\.best\/downloads\/OurCord-Windows-x64-setup\.exe/,
  );
});

test("deployment verifies the public installer checksum", () => {
  assert.match(workflow, /sha256sum "\$installer"/);
  assert.match(workflow, /sha256sum "\$downloaded"/);
  assert.match(workflow, /installer checksum mismatch/);
});
