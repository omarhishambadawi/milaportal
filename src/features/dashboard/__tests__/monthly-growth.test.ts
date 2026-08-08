import { describe, it, expect } from "vitest";
import {
  HISTORICAL_MONTHLY,
  buildInsights,
  buildMonthlyGrowth,
  formatCompactSAR,
  formatCount,
  formatGrowth,
  growthPct,
  monthWindow,
  monthsBetween,
  revenueDriver,
  type MonthlyTeamEntry,
} from "../monthly-growth";

/**
 * The baseline is data, so it is tested as data.
 *
 * These assertions are the supplied Customer Care and Telesales figures written
 * out a second time, independently of the module: if a digit is ever mistyped in
 * `HISTORICAL_MONTHLY`, or if a total stops being the sum of its Cash and
 * Wasfaty parts, this file says so. The expected growth rates come from the
 * business's own validation list and are checked against values the module
 * *derives* — no percentage is stored anywhere.
 */

const rows = buildMonthlyGrowth(HISTORICAL_MONTHLY);
const row = (month: string) => {
  const found = rows.find((r) => r.month === month);
  if (!found) throw new Error(`no row for ${month}`);
  return found;
};

describe("historical baseline — Customer Care", () => {
  const expected = [
    {
      month: "2026-02",
      cash: 21215.45,
      cashOrders: 105,
      wasfaty: 92587.76,
      wasfatyOrders: 182,
      total: 113803.21,
      orders: 287,
    },
    {
      month: "2026-03",
      cash: 29731.05,
      cashOrders: 161,
      wasfaty: 85989.8,
      wasfatyOrders: 203,
      total: 115720.85,
      orders: 364,
    },
    {
      month: "2026-04",
      cash: 48298.61,
      cashOrders: 300,
      wasfaty: 90470.2,
      wasfatyOrders: 196,
      total: 138768.81,
      orders: 496,
    },
    {
      month: "2026-05",
      cash: 102747.61,
      cashOrders: 564,
      wasfaty: 113692.89,
      wasfatyOrders: 313,
      total: 216440.5,
      orders: 877,
    },
    {
      month: "2026-06",
      cash: 121923.8,
      cashOrders: 624,
      wasfaty: 134423.73,
      wasfatyOrders: 456,
      total: 256347.53,
      orders: 1080,
    },
  ];

  for (const e of expected) {
    it(`matches the supplied figures for ${e.month}`, () => {
      const cc = row(e.month).customerCare;
      expect(cc).not.toBeNull();
      expect(cc!.cashRevenue).toBe(e.cash);
      expect(cc!.cashOrders).toBe(e.cashOrders);
      expect(cc!.wasfatyRevenue).toBe(e.wasfaty);
      expect(cc!.wasfatyOrders).toBe(e.wasfatyOrders);
      // Derived, then compared against the supplied total — the two must agree.
      expect(cc!.totalRevenue).toBeCloseTo(e.total, 2);
      expect(cc!.totalOrders).toBe(e.orders);
    });
  }
});

describe("historical baseline — Telesales", () => {
  const expected = [
    {
      month: "2026-04",
      cash: 51217.27,
      cashOrders: 85,
      wasfaty: 630.29,
      wasfatyOrders: 2,
      total: 51847.56,
      orders: 87,
    },
    {
      month: "2026-05",
      cash: 75024.43,
      cashOrders: 105,
      wasfaty: 26090.24,
      wasfatyOrders: 185,
      total: 101114.67,
      orders: 290,
    },
    {
      month: "2026-06",
      cash: 56748.31,
      cashOrders: 84,
      wasfaty: 107474.89,
      wasfatyOrders: 512,
      total: 188985.39,
      orders: 596,
    },
  ];

  for (const e of expected) {
    it(`matches the supplied figures for ${e.month}`, () => {
      const ts = row(e.month).telesales;
      expect(ts).not.toBeNull();
      expect(ts!.cashRevenue).toBe(e.cash);
      expect(ts!.cashOrders).toBe(e.cashOrders);
      expect(ts!.wasfatyRevenue).toBe(e.wasfaty);
      expect(ts!.wasfatyOrders).toBe(e.wasfatyOrders);
      expect(ts!.totalRevenue).toBeCloseTo(e.total, 2);
      expect(ts!.totalOrders).toBe(e.orders);
    });
  }

  it("has no Telesales data before April 2026", () => {
    expect(row("2026-02").telesales).toBeNull();
    expect(row("2026-03").telesales).toBeNull();
  });

  /**
   * June 2026 is the one supplied month whose two channels do not add up to its
   * stated total (56,748.31 + 107,474.89 = 164,223.20 against 188,985.39), and
   * the business's own +86.90% validation is measured on the stated total.
   *
   * So the stated total stays authoritative for revenue, growth and average
   * order value, and the 24,762.19 difference is **not modelled at all**. There
   * are two payment channels and only two; a residual is not a third one. The
   * mix chart reads `cashRevenue` and `wasfatyRevenue` directly, so nothing can
   * put that difference in front of a user as a category.
   */
  it("keeps the stated June total without inventing a third channel", () => {
    const june = row("2026-06").telesales!;
    expect(june.totalRevenue).toBeCloseTo(188985.39, 2);
    // The channels are exactly as supplied — the gap is absorbed by neither.
    expect(june.cashRevenue).toBe(56748.31);
    expect(june.wasfatyRevenue).toBe(107474.89);
    expect(june.cashRevenue + june.wasfatyRevenue).toBeCloseTo(164223.2, 2);
    // No residual is derived anywhere on the metrics.
    expect(Object.keys(june).some((k) => k.toLowerCase().includes("unallocated"))).toBe(false);
  });
});

describe("growth rates", () => {
  it("matches the Customer Care validation figures", () => {
    expect(row("2026-03").customerCare!.revenueGrowth).toBeCloseTo(1.69, 2);
    expect(row("2026-04").customerCare!.revenueGrowth).toBeCloseTo(19.92, 2);
    expect(row("2026-05").customerCare!.revenueGrowth).toBeCloseTo(55.97, 2);
    expect(row("2026-06").customerCare!.revenueGrowth).toBeCloseTo(18.44, 2);
  });

  it("matches the Telesales validation figures", () => {
    expect(row("2026-05").telesales!.revenueGrowth).toBeCloseTo(95.02, 2);
    expect(row("2026-06").telesales!.revenueGrowth).toBeCloseTo(86.9, 2);
  });

  it("gives the first month of each team no growth rate at all", () => {
    expect(row("2026-02").customerCare!.revenueGrowth).toBeNull();
    expect(row("2026-02").customerCare!.orderGrowth).toBeNull();
    // Telesales starts in April, so April is its first month — not a jump from zero.
    expect(row("2026-04").telesales!.revenueGrowth).toBeNull();
    expect(row("2026-04").telesales!.orderGrowth).toBeNull();
  });

  it("measures a team against its own previous month, not the calendar's", () => {
    // May Telesales is compared with April Telesales (95.02%), never with a
    // February that does not exist.
    const may = row("2026-05").telesales!;
    expect(may.revenueGrowth).toBeCloseTo(((101114.67 - 51847.56) / 51847.56) * 100, 6);
  });

  it("returns null rather than dividing by a zero previous month", () => {
    expect(growthPct(100, 0)).toBeNull();
    expect(growthPct(100, null)).toBeNull();
    expect(growthPct(150, 100)).toBeCloseTo(50, 6);
    expect(growthPct(50, 100)).toBeCloseTo(-50, 6);
  });
});

describe("combined totals", () => {
  it("is Customer Care alone while Telesales does not exist", () => {
    expect(row("2026-02").combined.totalRevenue).toBeCloseTo(113803.21, 2);
    expect(row("2026-03").combined.totalOrders).toBe(364);
  });

  it("adds both teams once Telesales starts", () => {
    expect(row("2026-06").combined.totalRevenue).toBeCloseTo(256347.53 + 188985.39, 2);
    expect(row("2026-06").combined.totalOrders).toBe(1080 + 596);
  });

  it("derives average order value from completed revenue over completed orders", () => {
    const june = row("2026-06").combined;
    expect(june.avgOrderValue).toBeCloseTo((256347.53 + 188985.39) / (1080 + 596), 6);
    expect(row("2026-06").customerCare!.avgCashOrderValue).toBeCloseTo(121923.8 / 624, 6);
    expect(row("2026-06").telesales!.avgWasfatyOrderValue).toBeCloseTo(107474.89 / 512, 6);
  });
});

describe("live months", () => {
  const live: MonthlyTeamEntry[] = [
    {
      month: "2026-07",
      team: "customer_care",
      source: "live",
      totals: { cashRevenue: 130000, cashOrders: 650, wasfatyRevenue: 140000, wasfatyOrders: 470 },
    },
    {
      month: "2026-07",
      team: "telesales",
      source: "live",
      totals: { cashRevenue: 60000, cashOrders: 90, wasfatyRevenue: 110000, wasfatyOrders: 520 },
    },
  ];

  it("continues each team's series from the baseline into live data", () => {
    const merged = buildMonthlyGrowth([...HISTORICAL_MONTHLY, ...live]);
    const july = merged.find((r) => r.month === "2026-07")!;
    expect(july.customerCare!.source).toBe("live");
    expect(july.customerCare!.revenueGrowth).toBeCloseTo(
      ((270000 - 256347.53) / 256347.53) * 100,
      6,
    );
    expect(july.telesales!.revenueGrowth).toBeCloseTo(((170000 - 188985.39) / 188985.39) * 100, 6);
  });

  it("lets a live month replace a baseline month for the same team", () => {
    const override: MonthlyTeamEntry = {
      month: "2026-06",
      team: "telesales",
      source: "live",
      totals: { cashRevenue: 1, cashOrders: 1, wasfatyRevenue: 1, wasfatyOrders: 1 },
    };
    const merged = buildMonthlyGrowth([...HISTORICAL_MONTHLY, override]);
    expect(merged.find((r) => r.month === "2026-06")!.telesales!.totalRevenue).toBe(2);
  });

  it("flags the month that is still running", () => {
    const merged = buildMonthlyGrowth([...HISTORICAL_MONTHLY, ...live], {
      currentMonth: "2026-07",
    });
    expect(merged.find((r) => r.month === "2026-07")!.partial).toBe(true);
    expect(merged.find((r) => r.month === "2026-06")!.partial).toBe(false);
  });
});

describe("month arithmetic", () => {
  it("enumerates an inclusive range and nothing when the range is inverted", () => {
    expect(monthsBetween("2026-07", "2026-09")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(monthsBetween("2026-07", "2026-07")).toEqual(["2026-07"]);
    expect(monthsBetween("2026-07", "2026-06")).toEqual([]);
  });

  it("spans a month from its first to its last calendar day", () => {
    expect(monthWindow("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthWindow("2026-07")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    // A leap February, so the window is not hard-coded to 28.
    expect(monthWindow("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("revenue driver", () => {
  it("ranks channels by the money they moved, not by their percentage", () => {
    // May 2026 Telesales: Wasfaty grew 630.29 → 26,090.24, which is +4,039% and
    // 25,459.95 SAR. Cash grew 51,217.27 → 75,024.43, which is only +46% but
    // 23,807.16 SAR. Wasfaty still wins here — narrowly, and on the money.
    const may = row("2026-05").telesales!;
    const april = row("2026-04").telesales!;
    expect(revenueDriver(may, april)).toEqual({
      channel: "Wasfaty",
      delta: 26090.24 - 630.29,
    });
  });

  it("names the channel that fell when revenue fell", () => {
    const driver = revenueDriver(row("2026-03").customerCare!, row("2026-02").customerCare!);
    // Cash rose 8,515.60; Wasfaty fell 6,597.96. Cash moved more, so Cash it is.
    expect(driver?.channel).toBe("Cash");
    expect(driver!.delta).toBeGreaterThan(0);
  });

  it("has no driver without a previous month, or when nothing moved", () => {
    expect(revenueDriver(row("2026-02").customerCare!, null)).toBeNull();
    expect(revenueDriver(row("2026-06").combined, row("2026-06").combined)).toBeNull();
  });
});

describe("insights", () => {
  it("gives at most three readings of the last complete month", () => {
    const insights = buildInsights(rows);
    expect(insights.length).toBeLessThanOrEqual(3);
    expect(insights.map((i) => i.id)).toEqual(["combined-growth", "growth-driver", "team-share"]);

    const [growth, driver, share] = insights;
    // Combined June revenue is 445,332.92 against May's 317,555.17 — +40.2%.
    expect(growth.value).toBe("+40.2%");
    expect(growth.label).toBe("Combined revenue growth in Jun 2026");
    expect(growth.tone).toBe("positive");

    expect(driver.value).toBe("Wasfaty");
    expect(driver.label).toBe("Primary revenue growth driver");

    // Customer Care 256,347.53 of 445,332.92 = 57.6%.
    expect(share.value).toBe("57.6%");
    expect(share.label).toBe("Customer Care contribution");
  });

  it("ignores a month that is still running", () => {
    const partialJuly: MonthlyTeamEntry[] = [
      {
        month: "2026-07",
        team: "customer_care",
        source: "live",
        totals: { cashRevenue: 10, cashOrders: 1, wasfatyRevenue: 0, wasfatyOrders: 0 },
      },
    ];
    const insights = buildInsights(
      buildMonthlyGrowth([...HISTORICAL_MONTHLY, ...partialJuly], { currentMonth: "2026-07" }),
    );
    // Subject is June, not the eight days of July that happen to be loaded.
    expect(insights.some((i) => i.label.includes("Jul 2026"))).toBe(false);
    expect(insights.some((i) => i.label.includes("Jun 2026"))).toBe(true);
  });

  it("emits nothing at all when there is no complete month", () => {
    expect(buildInsights([])).toEqual([]);
    const onlyPartial = buildMonthlyGrowth(
      HISTORICAL_MONTHLY.filter((e) => e.month === "2026-02"),
      { currentMonth: "2026-02" },
    );
    expect(buildInsights(onlyPartial)).toEqual([]);
  });

  it("skips the tiles whose calculation does not exist", () => {
    // February: no previous month, and no Telesales to compare against.
    const february = buildMonthlyGrowth(HISTORICAL_MONTHLY.filter((e) => e.month === "2026-02"));
    expect(buildInsights(february)).toEqual([]);
  });
});

describe("display formatting", () => {
  it("signs a growth rate to one decimal and dashes a missing one", () => {
    expect(formatGrowth(55.9718)).toBe("+56.0%");
    expect(formatGrowth(67.86)).toBe("+67.9%");
    expect(formatGrowth(-3.14)).toBe("−3.1%");
    expect(formatGrowth(0)).toBe("+0.0%");
    expect(formatGrowth(null)).toBe("—");
  });

  it("abbreviates money above ten thousand and keeps small figures exact", () => {
    expect(formatCompactSAR(747542.65)).toBe("SAR 747.5K");
    expect(formatCompactSAR(113803.21)).toBe("SAR 113.8K");
    expect(formatCompactSAR(1250000)).toBe("SAR 1.3M");
    expect(formatCompactSAR(2000000)).toBe("SAR 2M");
    expect(formatCompactSAR(274.13)).toBe("SAR 274");
    expect(formatCompactSAR(null)).toBe("—");
  });

  it("groups order counts rather than abbreviating them", () => {
    expect(formatCount(2727)).toBe("2,727");
    expect(formatCount(87)).toBe("87");
    expect(formatCount(null)).toBe("—");
  });
});
