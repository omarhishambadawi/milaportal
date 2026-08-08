import { describe, expect, it } from "vitest";
import { buildDailyReport, formatDailyReportText, money, type DailyReportInput } from "../daily";

/**
 * The figures from the report that is currently sent by hand, so the generated
 * one can be checked against the thing it replaces rather than against itself.
 */
const AUGUST_4: DailyReportInput = {
  date: "2026-08-04",
  basis: "all",
  telesales: {
    orders: { orders: 35, cashSales: 3103.4, wasfatySales: 11119.46 },
    calls: { total: 161, inbound: 12 },
  },
  customerCare: {
    orders: { orders: 83, cashSales: 1823.14, wasfatySales: 15631.78 },
    calls: { total: 63, inbound: 35 },
  },
};

describe("buildDailyReport", () => {
  it("reproduces the report operations currently send by hand", () => {
    const report = buildDailyReport(AUGUST_4);

    expect(report.dateLabel).toBe("Tuesday, August 4, 2026");
    expect(report.telesales.totalSales).toBeCloseTo(14222.86, 2);
    expect(report.customerCare.totalSales).toBeCloseTo(17454.92, 2);
    expect(report.combinedSales).toBeCloseTo(31677.78, 2);
  });

  it("derives Total Sales from Cash + Wasfaty, never from a separate total", () => {
    // The brief states this as an equation, and it has to hold on screen: the
    // `total` bucket's own sum can include an order whose type is neither, and
    // printing that would make the four lines above it fail to add up in front
    // of whoever is reading them.
    const report = buildDailyReport(AUGUST_4);
    for (const team of [report.telesales, report.customerCare]) {
      expect(team.totalSales).toBeCloseTo(team.cashSales + team.wasfatySales, 6);
    }
    expect(report.combinedSales).toBeCloseTo(
      report.telesales.totalSales + report.customerCare.totalSales,
      6,
    );
  });

  it("handles a day with nothing on it", () => {
    const empty = buildDailyReport({
      date: "2026-08-04",
      basis: "all",
      telesales: {
        orders: { orders: 0, cashSales: 0, wasfatySales: 0 },
        calls: { total: 0, inbound: 0 },
      },
      customerCare: {
        orders: { orders: 0, cashSales: 0, wasfatySales: 0 },
        calls: { total: 0, inbound: 0 },
      },
    });
    expect(empty.combinedSales).toBe(0);
    expect(formatDailyReportText(empty)).toContain("0.00 SAR");
  });

  it("does not throw on an unparseable date", () => {
    const report = buildDailyReport({ ...AUGUST_4, date: "not-a-date" });
    expect(report.dateLabel).toBe("not-a-date");
  });
});

describe("money", () => {
  it("always prints two decimals", () => {
    // The manual report reads "3,103.4 SAR" on one line and "11,119.46 SAR" on
    // the next, because `fmtSAR` uses maximumFractionDigits. In a column someone
    // is going to add up on a phone, a missing decimal reads as a typo.
    expect(money(3103.4)).toBe("3,103.40 SAR");
    expect(money(11119.46)).toBe("11,119.46 SAR");
    expect(money(0)).toBe("0.00 SAR");
    expect(money(31677.78)).toBe("31,677.78 SAR");
  });
});

describe("formatDailyReportText", () => {
  const text = formatDailyReportText(buildDailyReport(AUGUST_4));

  it("matches the format that goes out on WhatsApp", () => {
    expect(text).toBe(
      [
        "Telesales Daily Report — Tuesday, August 4, 2026",
        "",
        "• Total Calls: 161",
        "• Total Orders: 35",
        "• Total Cash: 3,103.40 SAR",
        "• Total Wasfaty: 11,119.46 SAR",
        "",
        "➡️ Total Sales: 14,222.86 SAR",
        "",
        "Customer Care Daily Report — Tuesday, August 4, 2026",
        "",
        "• Inbound Calls: 35",
        "• Total Calls (Inbound & Outbound): 63",
        "• Total Orders: 83",
        "• Cash Sales: 1,823.14 SAR",
        "• Wasfaty Sales: 15,631.78 SAR",
        "",
        "➡️ Total Sales: 17,454.92 SAR",
        "",
        "➡️ Total Daily Sales (Customer Care + Telesales): 31,677.78 SAR",
      ].join("\n"),
    );
  });

  it("carries no markup that WhatsApp would render or mangle", () => {
    // WhatsApp turns *x* bold, _x_ italic and ~x~ struck through, so a stray one
    // of those arrives as formatting or as debris. The message is plain text.
    expect(text).not.toMatch(/[*_~`]/);
    expect(text).not.toContain("<");
  });

  it("says so when the report was run on a different basis", () => {
    // The everyday message must stay byte-identical to the one being replaced,
    // so the note appears only when the basis is not the default.
    expect(text).not.toContain("Completed orders only");
    const completed = formatDailyReportText(buildDailyReport({ ...AUGUST_4, basis: "completed" }));
    expect(completed).toContain("(Completed orders only)");
  });
});
