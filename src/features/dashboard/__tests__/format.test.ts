import { describe, expect, it } from "vitest";
import { formatCompactSAR, formatCount, formatGrowth, formatPercent } from "../format";

/**
 * The formatting rules the analytics sections are read through.
 *
 * Pinned as a table because the whole point of the module is that two sections
 * — Monthly performance and Delivery methods — print a figure the same way, and
 * the failure mode is one of them quietly drifting to two decimals.
 */

describe("formatGrowth", () => {
  it("signs a rate to one decimal and dashes a missing one", () => {
    expect(formatGrowth(55.9718)).toBe("+56.0%");
    expect(formatGrowth(67.86)).toBe("+67.9%");
    expect(formatGrowth(-3.14)).toBe("−3.1%");
    expect(formatGrowth(0)).toBe("+0.0%");
    expect(formatGrowth(null)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("prints an unsigned share to one decimal", () => {
    expect(formatPercent(89.876)).toBe("89.9%");
    expect(formatPercent(10.124)).toBe("10.1%");
    expect(formatPercent(100)).toBe("100.0%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("formatCompactSAR", () => {
  it("abbreviates above ten thousand and keeps small figures exact", () => {
    expect(formatCompactSAR(747542.65)).toBe("SAR 747.5K");
    expect(formatCompactSAR(113803.21)).toBe("SAR 113.8K");
    expect(formatCompactSAR(166572.02)).toBe("SAR 166.6K");
    expect(formatCompactSAR(28979.12)).toBe("SAR 29K");
    expect(formatCompactSAR(6547.06)).toBe("SAR 6,547");
    expect(formatCompactSAR(1250000)).toBe("SAR 1.3M");
    expect(formatCompactSAR(2000000)).toBe("SAR 2M");
    expect(formatCompactSAR(274.13)).toBe("SAR 274");
    expect(formatCompactSAR(null)).toBe("—");
  });
});

describe("formatCount", () => {
  it("groups order counts rather than abbreviating them", () => {
    expect(formatCount(2727)).toBe("2,727");
    expect(formatCount(731)).toBe("731");
    expect(formatCount(87)).toBe("87");
    expect(formatCount(null)).toBe("—");
  });
});
