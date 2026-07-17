import { describe, it, expect } from "vitest";
import { clampMenuPosition } from "./menu";

describe("clampMenuPosition", () => {
  it("leaves an in-bounds menu where it is", () => {
    expect(clampMenuPosition(100, 100, 180, 120, 1280, 800)).toEqual({ left: 100, top: 100 });
  });
  it("flips back from the right and bottom edges", () => {
    expect(clampMenuPosition(1200, 760, 180, 120, 1280, 800)).toEqual({ left: 1092, top: 672 });
  });
  it("never returns a negative position", () => {
    expect(clampMenuPosition(-50, -50, 180, 120, 1280, 800)).toEqual({ left: 8, top: 8 });
  });
  it("respects a tiny viewport by pinning to the margin", () => {
    expect(clampMenuPosition(10, 10, 400, 400, 300, 300)).toEqual({ left: 8, top: 8 });
  });
});
