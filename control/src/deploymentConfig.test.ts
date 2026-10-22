import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Free-plan Worker deployment configuration", () => {
  it.each(["control", "service"])("%s omits paid-only CPU limits without removing request rate limits", (moduleName) => {
    const configuration = readFileSync(join(__dirname, "../../", moduleName, "wrangler.toml"), "utf8");
    expect(configuration).not.toMatch(/^\s*cpu_ms\s*=/m);
    for (const limit of [5, 10, 20, 30, 60, 120]) {
      expect(configuration).toContain(`name = "RATE_LIMIT_${limit}"`);
      expect(configuration).toContain(`simple = { limit = ${limit}, period = 60 }`);
    }
  });
});
