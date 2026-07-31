import { describe, expect, it } from "vitest";
import { clampFlyoutTop } from "../nav-flyout";

/**
 * The flyout itself needs a browser to look at, but its placement arithmetic
 * does not — and "never overflow viewport" is the part where a real bug can
 * hide, so it is pinned here.
 *
 * Panel height is childCount * 44 + 24, capped at 420.
 */
describe("clampFlyoutTop", () => {
  it("aligns with the trigger when there is room below", () => {
    expect(clampFlyoutTop(120, 4, 900)).toBe(120);
  });

  it("slides up so a menu opened near the bottom stays fully on screen", () => {
    // 6 children => 288px tall. From a trigger at 800px in an 900px viewport it
    // would end at 1088 — off the bottom — so it moves up to 900-288-8 = 604.
    expect(clampFlyoutTop(800, 6, 900)).toBe(604);
  });

  it("never positions above the top margin, however short the viewport", () => {
    expect(clampFlyoutTop(500, 6, 200)).toBe(8);
    expect(clampFlyoutTop(0, 2, 900)).toBe(8);
  });

  it("caps the assumed height so a huge menu does not push itself off the top", () => {
    // 40 children would be 1784px; the cap holds it at 420.
    expect(clampFlyoutTop(900, 40, 1000)).toBe(1000 - 420 - 8);
  });

  it("keeps the whole panel inside the viewport for every trigger position", () => {
    const viewport = 800;
    const children = 6;
    const height = children * 44 + 24;
    for (let triggerTop = 0; triggerTop <= viewport; triggerTop += 25) {
      const top = clampFlyoutTop(triggerTop, children, viewport);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(top + height).toBeLessThanOrEqual(viewport);
    }
  });
});
