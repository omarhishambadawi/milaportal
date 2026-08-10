import { describe, expect, it } from "vitest";
import {
  buildCallCenterBreakdown,
  buildCallSummary,
  buildExecutiveSummary,
  buildOrderTypeSplit,
  buildTeamPerformance,
  share,
  summarizeTrend,
  type BucketStats,
  type OrderBuckets,
} from "../monthly";

const stats = (
  totalOrders: number,
  completedOrders: number,
  totalSales: number,
  completedSales: number,
): BucketStats => ({
  totalOrders,
  completedOrders,
  totalSales,
  completedSales,
  completionRate: totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0,
});

const MONTH: OrderBuckets = {
  cash: stats(400, 360, 90_000, 80_000),
  wasfaty: stats(600, 540, 260_000, 240_000),
  total: stats(1000, 900, 350_000, 320_000),
};

describe("share", () => {
  it("returns zero rather than NaN for an empty denominator", () => {
    // A month with no orders is a valid month. "NaN%" on a management report
    // reads as the report being broken.
    expect(share(0, 0)).toBe(0);
    expect(share(5, 0)).toBe(0);
    expect(share(25, 100)).toBe(25);
  });
});

describe("buildExecutiveSummary", () => {
  it("summarizes the month from the dashboard's own buckets", () => {
    const summary = buildExecutiveSummary(MONTH);
    expect(summary.totalOrders).toBe(1000);
    expect(summary.completedOrders).toBe(900);
    expect(summary.completionRate).toBe(90);
    expect(summary.completedSales).toBe(320_000);
    expect(summary.cashSales).toBe(80_000);
    expect(summary.wasfatySales).toBe(240_000);
  });

  it("takes average order value on the completed basis", () => {
    // Mixing total sales with total orders drifts upward exactly when the month
    // went badly: a cancelled order adds to the denominator and nothing to the
    // business.
    expect(buildExecutiveSummary(MONTH).averageOrderValue).toBeCloseTo(320_000 / 900, 6);
  });

  it("survives a month with no data at all", () => {
    const summary = buildExecutiveSummary({});
    expect(summary.totalOrders).toBe(0);
    expect(summary.averageOrderValue).toBe(0);
    expect(Number.isNaN(summary.averageOrderValue)).toBe(false);
  });
});

describe("buildTeamPerformance", () => {
  const care: OrderBuckets = {
    cash: stats(200, 180, 40_000, 36_000),
    wasfaty: stats(400, 360, 160_000, 150_000),
    total: stats(600, 540, 200_000, 186_000),
  };
  const telesales: OrderBuckets = {
    cash: stats(200, 180, 50_000, 44_000),
    wasfaty: stats(200, 180, 100_000, 90_000),
    total: stats(400, 360, 150_000, 134_000),
  };

  it("compares the two teams and totals them", () => {
    const { rows, total } = buildTeamPerformance(care, telesales, MONTH);
    expect(rows.map((r) => r.team)).toEqual(["Customer Care", "Telesales"]);
    expect(rows[0].completedSales).toBe(186_000);
    expect(rows[1].completedSales).toBe(134_000);
    expect(total.completedSales).toBe(320_000);
  });

  it("expresses contribution against the month, so the teams sum to 100", () => {
    const { rows } = buildTeamPerformance(care, telesales, MONTH);
    expect(rows[0].contribution + rows[1].contribution).toBeCloseTo(100, 6);
  });

  it("takes the total from the month's own buckets, not from adding the teams", () => {
    // An order belonging to neither team then shows up as the contributions
    // failing to reach 100 rather than vanishing from the report entirely.
    const orphaned: OrderBuckets = { ...MONTH, total: stats(1100, 1000, 400_000, 370_000) };
    const { rows, total } = buildTeamPerformance(care, telesales, orphaned);
    expect(total.completedSales).toBe(370_000);
    expect(rows[0].contribution + rows[1].contribution).toBeLessThan(100);
  });
});

describe("buildOrderTypeSplit", () => {
  it("splits completed orders and sales, each pair summing to 100", () => {
    const split = buildOrderTypeSplit(MONTH);
    expect(split.rows.map((r) => r.label)).toEqual(["Cash", "Wasfaty"]);
    expect(split.totalOrders).toBe(900);
    expect(split.totalSales).toBe(320_000);
    expect(split.rows[0].ordersPercent + split.rows[1].ordersPercent).toBeCloseTo(100, 6);
    expect(split.rows[0].salesPercent + split.rows[1].salesPercent).toBeCloseTo(100, 6);
  });

  it("divides by the pair's own sum, not the total bucket", () => {
    // The two percentages are read against each other, so they have to reach
    // 100 between them even when the `total` bucket counts something else.
    const withOther: OrderBuckets = { ...MONTH, total: stats(1200, 1100, 400_000, 380_000) };
    const split = buildOrderTypeSplit(withOther);
    expect(split.totalOrders).toBe(900);
    expect(split.rows[0].ordersPercent + split.rows[1].ordersPercent).toBeCloseTo(100, 6);
  });
});

describe("buildCallSummary", () => {
  const totals = {
    total: 1000,
    inbound: 800,
    answered: 700,
    missed: 60,
    abandoned: 40,
    talkSeconds: 140_000,
  };

  it("follows the phone system's split when the Call Report is available", () => {
    // The shared classifier decides this, not the report. A management report
    // that quietly picked CDR while the Calls page showed Yeastar would be the
    // exact mismatch that classifier was written to end.
    const summary = buildCallSummary(totals, { missedCalls: 75, abandonedCalls: 25 }, "cdr");
    expect(summary.missed).toBe(75);
    expect(summary.abandoned).toBe(25);
    expect(summary.splitSource).toBe("call_report");
  });

  it("falls back to the call records when it is not, and says which", () => {
    const summary = buildCallSummary(totals, null, "cdr");
    expect(summary.missed).toBe(60);
    expect(summary.abandoned).toBe(40);
    expect(summary.splitSource).toBe("cdr");
  });

  it("rates missed and abandoned against inbound, not against every call", () => {
    // An outbound call cannot be missed or abandoned, so including the dialler's
    // volume in the denominator flatters both rates in proportion to how much
    // Telesales worked that month.
    const summary = buildCallSummary(totals, null, "cdr");
    expect(summary.missedRate).toBeCloseTo((60 / 800) * 100, 6);
    expect(summary.abandonedRate).toBeCloseTo((40 / 800) * 100, 6);
    expect(summary.answerRate).toBeCloseTo((700 / 1000) * 100, 6);
  });

  it("reports average talk time per answered call, or nothing", () => {
    expect(buildCallSummary(totals, null, "cdr").avgTalkSec).toBeCloseTo(200, 6);
    expect(buildCallSummary({ ...totals, answered: 0 }, null, "cdr").avgTalkSec).toBeNull();
  });
});

describe("summarizeTrend", () => {
  const month = [
    { date: "08-01", total: 100, completed: 90 },
    { date: "08-02", total: 0, completed: 0 },
    { date: "08-03", total: 300, completed: 250 },
    { date: "08-04", total: 60, completed: 50 },
  ];

  it("names the best and weakest trading days", () => {
    const highlights = summarizeTrend(month);
    expect(highlights.best?.date).toBe("08-03");
    expect(highlights.weakest?.date).toBe("08-04");
  });

  it("excludes closed days from the averages and counts them instead", () => {
    // A public holiday is not the month's worst trading day, and letting it take
    // that label buries the day that genuinely underperformed.
    const highlights = summarizeTrend(month);
    expect(highlights.quietDays).toBe(1);
    expect(highlights.averageDay).toBeCloseTo((90 + 250 + 50) / 3, 6);
  });

  it("handles a month that never traded", () => {
    const highlights = summarizeTrend([{ date: "08-01", total: 0, completed: 0 }]);
    expect(highlights.best).toBeNull();
    expect(highlights.weakest).toBeNull();
    expect(highlights.averageDay).toBe(0);
    expect(highlights.quietDays).toBe(1);
  });

  it("handles an empty window", () => {
    const highlights = summarizeTrend([]);
    expect(highlights.best).toBeNull();
    expect(highlights.quietDays).toBe(0);
  });
});

describe("revenue lost", () => {
  it("is total revenue that never completed, not a second count", () => {
    // Completed is decided server-side by `orders_kpis`; the subtraction cannot
    // disagree with it because it is taken from the same two figures the KPI
    // strip already shows.
    const summary = buildExecutiveSummary(MONTH);
    expect(summary.revenueLost).toBe(350_000 - 320_000);
    expect(summary.totalSales - summary.completedSales).toBe(summary.revenueLost);
  });

  it("is zero for a month with nothing in it", () => {
    expect(buildExecutiveSummary({}).revenueLost).toBe(0);
  });

  it("carries a team's total revenue alongside its completed revenue", () => {
    // The revenue-by-team chart plots both, and it reads them off the same rows
    // the table above it renders rather than from `orders_teams` — one figure
    // for "Telesales revenue" on the page, not two that could drift.
    const { rows, total } = buildTeamPerformance(MONTH, {}, MONTH);
    expect(rows[0].totalSales).toBe(350_000);
    expect(rows[1].totalSales).toBe(0);
    expect(total.totalSales).toBe(350_000);
  });
});

describe("buildCallCenterBreakdown", () => {
  const TEAMS = [
    { team: "customer_care" as const, calls: 1200 },
    { team: "telesales" as const, calls: 800 },
  ];

  it("splits volume by team out of the analytics' own team comparison", () => {
    const breakdown = buildCallCenterBreakdown(TEAMS, 2100, 14.5);
    expect(breakdown.customerCare.totalCalls).toBe(1200);
    expect(breakdown.telesales.totalCalls).toBe(800);
  });

  it("takes the network total from the response rather than adding the teams", () => {
    // A call from an extension mapped to no team belongs in the network total
    // and in neither team. Adding the rows would silently drop it — here, the
    // hundred calls that are the difference between 2,100 and 2,000.
    expect(buildCallCenterBreakdown(TEAMS, 2100, null).overall.totalCalls).toBe(2100);
  });

  it("carries a conversion rate for Telesales only", () => {
    // The brief's asymmetry and the Calls module's: conversion is orders ÷
    // answered outbound work, and an inbound care queue does not convert.
    const breakdown = buildCallCenterBreakdown(TEAMS, 2100, 14.5);
    expect(breakdown.telesales.conversionRate).toBe(14.5);
    expect(breakdown.customerCare).not.toHaveProperty("conversionRate");
  });

  it("reports an absent conversion rate as null rather than zero", () => {
    // Zero percent conversion and "the orders join did not answer" are
    // different facts, and a report that prints the second as the first is
    // telling management Telesales sold nothing.
    expect(buildCallCenterBreakdown(TEAMS, 2100, null).telesales.conversionRate).toBeNull();
  });

  it("reads a missing team as no calls", () => {
    const breakdown = buildCallCenterBreakdown([], 0, null);
    expect(breakdown.customerCare.totalCalls).toBe(0);
    expect(breakdown.telesales.totalCalls).toBe(0);
    expect(breakdown.overall.totalCalls).toBe(0);
  });
});
