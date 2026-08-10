import { resolveQueueOutcomeSplit, type MetricSource } from "@/lib/yeastar/call-classification";
import type { ReportQueueOutcomes } from "@/lib/yeastar/call-classification";

/**
 * The monthly management report, as a value.
 *
 * Same contract as `./daily`: pure, and a *rearrangement* of figures the
 * Dashboard already produced rather than a second computation of them. Every
 * input here is something `useDashboardData` fetched for the same window, so a
 * number in this report and the same number on the dashboard cannot disagree —
 * not because they are checked against each other, but because there is only one
 * of them.
 *
 * The reference workbook this replaces carried eleven sheets. What management
 * actually reads off it is here: how much did we sell, how much completed, Cash
 * against Wasfaty, Customer Care against Telesales, how orders were fulfilled,
 * how the month moved day to day, and how the phones did. Everything else in
 * that workbook was working-out, and the portal does the working-out.
 */

/** One `orders_kpis` bucket, as the Dashboard already derives it. */
export interface BucketStats {
  totalSales: number;
  completedSales: number;
  totalOrders: number;
  completedOrders: number;
  completionRate: number;
}

export interface OrderBuckets {
  cash?: BucketStats;
  wasfaty?: BucketStats;
  total?: BucketStats;
}

const EMPTY_BUCKET: BucketStats = {
  totalSales: 0,
  completedSales: 0,
  totalOrders: 0,
  completedOrders: 0,
  completionRate: 0,
};

export const bucket = (value: BucketStats | undefined): BucketStats => value ?? EMPTY_BUCKET;

/** Percentage, guarded. A month with no orders is a valid month, not a NaN. */
export function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/* -------------------------------------------------------------------------- */
/* Executive summary                                                           */
/* -------------------------------------------------------------------------- */

export interface ExecutiveSummary {
  totalOrders: number;
  completedOrders: number;
  completionRate: number;
  totalSales: number;
  completedSales: number;
  cashSales: number;
  wasfatySales: number;
  /**
   * Completed sales per completed order.
   *
   * Deliberately on the completed basis rather than dividing total sales by
   * total orders: a cancelled order contributes its value to one side of that
   * fraction and nothing to the business, so the mixed version drifts upward
   * exactly when the month went badly.
   */
  averageOrderValue: number;
  /**
   * Revenue that was logged and never completed.
   *
   * A subtraction of two figures already on the report rather than a third
   * query: total sales minus completed sales is, by the RPC's own definition of
   * completed, exactly the value sitting in orders that did not close.
   */
  revenueLost: number;
}

export function buildExecutiveSummary(buckets: OrderBuckets): ExecutiveSummary {
  const total = bucket(buckets.total);
  const cash = bucket(buckets.cash);
  const wasfaty = bucket(buckets.wasfaty);

  return {
    totalOrders: total.totalOrders,
    completedOrders: total.completedOrders,
    completionRate: total.completionRate,
    totalSales: total.totalSales,
    completedSales: total.completedSales,
    cashSales: cash.completedSales,
    wasfatySales: wasfaty.completedSales,
    averageOrderValue: total.completedOrders > 0 ? total.completedSales / total.completedOrders : 0,
    revenueLost: total.totalSales - total.completedSales,
  };
}

/* -------------------------------------------------------------------------- */
/* Team performance                                                            */
/* -------------------------------------------------------------------------- */

export interface TeamPerformanceRow {
  team: string;
  orders: number;
  completedOrders: number;
  completionRate: number;
  /** Every order logged to the team, completed or not. Drives the revenue chart. */
  totalSales: number;
  completedSales: number;
  cashSales: number;
  wasfatySales: number;
  averageOrderValue: number;
  /** Share of the month's completed sales. The two teams sum to 100. */
  contribution: number;
}

function teamRow(
  team: string,
  buckets: OrderBuckets,
  monthCompletedSales: number,
): TeamPerformanceRow {
  const total = bucket(buckets.total);
  const cash = bucket(buckets.cash);
  const wasfaty = bucket(buckets.wasfaty);

  return {
    team,
    orders: total.totalOrders,
    completedOrders: total.completedOrders,
    completionRate: total.completionRate,
    totalSales: total.totalSales,
    completedSales: total.completedSales,
    cashSales: cash.completedSales,
    wasfatySales: wasfaty.completedSales,
    averageOrderValue: total.completedOrders > 0 ? total.completedSales / total.completedOrders : 0,
    contribution: share(total.completedSales, monthCompletedSales),
  };
}

/**
 * Customer Care against Telesales, plus the combined line.
 *
 * The total row is taken from the month's own buckets rather than by adding the
 * two teams, so an order belonging to neither team — or to a team added later —
 * shows up as the two contributions failing to reach 100 instead of vanishing.
 */
export function buildTeamPerformance(
  customerCare: OrderBuckets,
  telesales: OrderBuckets,
  overall: OrderBuckets,
): { rows: TeamPerformanceRow[]; total: TeamPerformanceRow } {
  const monthCompletedSales = bucket(overall.total).completedSales;
  return {
    rows: [
      teamRow("Customer Care", customerCare, monthCompletedSales),
      teamRow("Telesales", telesales, monthCompletedSales),
    ],
    total: teamRow("Total", overall, monthCompletedSales),
  };
}

/* -------------------------------------------------------------------------- */
/* Cash vs Wasfaty                                                             */
/* -------------------------------------------------------------------------- */

export interface OrderTypeRow {
  label: string;
  orders: number;
  sales: number;
  /** Share of completed orders. */
  ordersPercent: number;
  /** Share of completed sales. */
  salesPercent: number;
}

export function buildOrderTypeSplit(buckets: OrderBuckets): {
  rows: OrderTypeRow[];
  totalOrders: number;
  totalSales: number;
} {
  const cash = bucket(buckets.cash);
  const wasfaty = bucket(buckets.wasfaty);

  // The pair's own sum, not the `total` bucket: these two percentages are read
  // against each other and have to reach 100 between them.
  const totalOrders = cash.completedOrders + wasfaty.completedOrders;
  const totalSales = cash.completedSales + wasfaty.completedSales;

  const row = (label: string, stats: BucketStats): OrderTypeRow => ({
    label,
    orders: stats.completedOrders,
    sales: stats.completedSales,
    ordersPercent: share(stats.completedOrders, totalOrders),
    salesPercent: share(stats.completedSales, totalSales),
  });

  return {
    rows: [row("Cash", cash), row("Wasfaty", wasfaty)],
    totalOrders,
    totalSales,
  };
}

/* -------------------------------------------------------------------------- */
/* Call centre                                                                 */
/* -------------------------------------------------------------------------- */

export interface CallSummary {
  totalCalls: number;
  answered: number;
  missed: number;
  abandoned: number;
  answerRate: number;
  missedRate: number;
  abandonedRate: number;
  /** Mean talk time in seconds. Null when nothing was answered. */
  avgTalkSec: number | null;
  /** Which system decided the Missed / Abandoned split. */
  splitSource: MetricSource;
}

export interface CallTotalsInput {
  total: number;
  inbound: number;
  answered: number;
  missed: number;
  abandoned: number;
  talkSeconds: number;
}

/**
 * The month's telephony, at management altitude.
 *
 * The Missed / Abandoned split is **not** recomputed here. It goes through
 * `resolveQueueOutcomeSplit`, the same shared classifier the Calls pages use, so
 * the report follows Yeastar's own definition when the Call Report is available
 * and CDR's threshold when it is not — and says which it used. A report that
 * quietly picked one while the Calls page showed the other would be the exact
 * mismatch that classifier was written to end.
 *
 * Rates are taken against inbound calls rather than all calls: an outbound call
 * cannot be missed or abandoned, and including the dialler's volume in the
 * denominator flatters both rates in proportion to how much Telesales worked.
 */
export function buildCallSummary(
  totals: CallTotalsInput,
  reportQueue: ReportQueueOutcomes | null,
  cdrSource: MetricSource,
): CallSummary {
  const split = resolveQueueOutcomeSplit(
    { missed: totals.missed, abandoned: totals.abandoned },
    reportQueue,
    cdrSource,
  );

  return {
    totalCalls: totals.total,
    answered: totals.answered,
    missed: split.missed,
    abandoned: split.abandoned,
    answerRate: share(totals.answered, totals.total),
    missedRate: share(split.missed, totals.inbound),
    abandonedRate: share(split.abandoned, totals.inbound),
    avgTalkSec: totals.answered > 0 ? totals.talkSeconds / totals.answered : null,
    splitSource: split.source,
  };
}

/* -------------------------------------------------------------------------- */
/* Call centre, by team                                                        */
/* -------------------------------------------------------------------------- */

/** One row of the analytics' own `teamCompare`, narrowed to what a report reads. */
export interface TeamCallInput {
  team: "customer_care" | "telesales";
  calls: number;
}

export interface CallCenterBreakdown {
  customerCare: { totalCalls: number };
  /**
   * Telesales carries a conversion rate and Customer Care does not, which is the
   * brief's own asymmetry and the Calls module's: conversion is orders ÷
   * answered outbound work, and an inbound care queue does not convert.
   */
  telesales: { totalCalls: number; conversionRate: number | null };
  overall: { totalCalls: number };
}

/**
 * Customer Care and Telesales call volumes, split out of the month's own
 * analytics rather than fetched per team.
 *
 * `teamCompare` is already in the single whole-network analytics response the
 * report loads, keyed by the same extension-to-agent mapping and team
 * classification every Calls page uses. Splitting it here costs no query and
 * cannot disagree with those pages.
 *
 * `overall` is the response's own total, not the two teams added: a call from an
 * extension mapped to no team belongs in the network total and in neither team,
 * and adding the rows would silently drop it.
 */
export function buildCallCenterBreakdown(
  teams: readonly TeamCallInput[],
  overallTotalCalls: number,
  telesalesConversionRate: number | null,
): CallCenterBreakdown {
  const calls = (team: TeamCallInput["team"]) => teams.find((row) => row.team === team)?.calls ?? 0;

  return {
    customerCare: { totalCalls: calls("customer_care") },
    telesales: { totalCalls: calls("telesales"), conversionRate: telesalesConversionRate },
    overall: { totalCalls: overallTotalCalls },
  };
}

/* -------------------------------------------------------------------------- */
/* Trend                                                                       */
/* -------------------------------------------------------------------------- */

export interface TrendPoint {
  date: string;
  total: number;
  completed: number;
}

export interface TrendHighlights {
  /** The day that sold most, by completed sales. Null for an empty month. */
  best: TrendPoint | null;
  /** The weakest day that still traded. A closed day is not a bad day. */
  weakest: TrendPoint | null;
  /** Mean completed sales across days that traded. */
  averageDay: number;
  /** Days in the window with no completed sales at all. */
  quietDays: number;
}

/**
 * What a manager looks for in the trend line, stated rather than eyeballed.
 *
 * Days with nothing completed are excluded from best/weakest/average and counted
 * separately: a public holiday is not the month's worst trading day, and letting
 * it take that label buries the day that genuinely underperformed.
 */
export function summarizeTrend(points: readonly TrendPoint[]): TrendHighlights {
  const trading = points.filter((point) => point.completed > 0);
  if (trading.length === 0) {
    return { best: null, weakest: null, averageDay: 0, quietDays: points.length };
  }

  let best = trading[0];
  let weakest = trading[0];
  let sum = 0;
  for (const point of trading) {
    if (point.completed > best.completed) best = point;
    if (point.completed < weakest.completed) weakest = point;
    sum += point.completed;
  }

  return {
    best,
    weakest,
    averageDay: sum / trading.length,
    quietDays: points.length - trading.length,
  };
}
