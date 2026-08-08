import { format, parse } from "date-fns";

/**
 * Month-over-month growth analytics, as a value.
 *
 * Same contract as `@/features/reports/monthly`: pure, and a *rearrangement* of
 * figures that already exist rather than a second computation of them. Every
 * live figure fed in here comes from `orders_kpis` — the RPC the Dashboard's own
 * headline cards read — so a number in this section and the same number on the
 * cards above it cannot disagree.
 *
 * Two things this module is deliberate about:
 *
 *   - **Completed orders only.** The caller passes completed revenue and
 *     completed counts; there is no status logic here and no second definition
 *     of "completed". The single definition is `status = 'Completed'` inside
 *     `orders_kpis` (see 20260720014541_orders_analytics_kpis.sql).
 *   - **Absent is not zero.** Telesales did not exist before April 2026, and a
 *     team with no data for a month is `null` all the way to the cell, never a
 *     0 that would read as "they sold nothing" and would manufacture a -100%.
 */

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

export type GrowthTeam = "customer_care" | "telesales";

export const GROWTH_TEAMS = ["customer_care", "telesales"] as const;

/** Where a month's figures came from. Surfaced so the UI can say so. */
export type GrowthSource = "historical" | "live" | "mixed";

/** Completed-order totals for one team in one month, as recorded/fetched. */
export interface MonthTeamTotals {
  cashRevenue: number;
  cashOrders: number;
  wasfatyRevenue: number;
  wasfatyOrders: number;
  /**
   * The month's authoritative total, for the one case where it is not the sum of
   * the two channels above.
   *
   * Live months never set this — `orders_kpis` returns a `total` bucket that is
   * the same rows as its `cash` and `wasfaty` buckets, so it reconciles by
   * construction. It exists for the historical baseline, where June 2026
   * Telesales was supplied as Cash 56,748.31 + Wasfaty 107,474.89 against a
   * stated total of 188,985.39 — a 24,762.19 gap the business's own +86.90%
   * growth validation is measured on. Deriving the total from the parts would
   * silently restate that month as 164,223.20 and its growth as +62.41%.
   *
   * So the stated total wins, and the difference is carried through to
   * `unallocatedRevenue` rather than being absorbed into either channel.
   */
  totalRevenue?: number;
  totalOrders?: number;
}

/** A month's totals with the derived-or-stated figures resolved. */
type ResolvedTotals = Required<MonthTeamTotals>;

/** One team's month, before any derivation. The input to `buildMonthlyGrowth`. */
export interface MonthlyTeamEntry {
  /** `yyyy-MM`. */
  month: string;
  team: GrowthTeam;
  totals: MonthTeamTotals;
  source: Exclude<GrowthSource, "mixed">;
}

/** Everything the tables, charts and insights read for one team-month. */
export interface TeamMonthMetrics extends ResolvedTotals {
  /**
   * Revenue in the total that belongs to neither channel — 0 for every month
   * that reconciles, which is all of them but June 2026 Telesales. Charted as
   * its own stacked segment so a revenue-mix bar always adds up to its total.
   */
  unallocatedRevenue: number;
  unallocatedOrders: number;
  /** `null` rather than 0 when there are no orders to average over. */
  avgOrderValue: number | null;
  avgCashOrderValue: number | null;
  avgWasfatyOrderValue: number | null;
  /** `null` when there is no comparable previous month. */
  revenueGrowth: number | null;
  orderGrowth: number | null;
  cashRevenueGrowth: number | null;
  cashOrderGrowth: number | null;
  wasfatyRevenueGrowth: number | null;
  wasfatyOrderGrowth: number | null;
  source: GrowthSource;
}

export interface MonthRow {
  /** `yyyy-MM`. */
  month: string;
  /** `MMM yyyy`, e.g. "Feb 2026". */
  label: string;
  /** `null` when the team was not operating that month — not zero. */
  customerCare: TeamMonthMetrics | null;
  telesales: TeamMonthMetrics | null;
  /** Every team that has data for the month, added together. */
  combined: TeamMonthMetrics;
  /** The month is still running, so its figures are partial. */
  partial: boolean;
}

/* -------------------------------------------------------------------------- */
/* Historical baseline                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The first month the portal's own completed-order data is authoritative for.
 *
 * February–June 2026 predates the orders table as a source of truth, so those
 * months are a fixed, typed baseline below. July onward is fetched live and
 * nothing here is ever written for it — which is why future months appear on
 * this section by themselves, with no code change.
 */
export const LIVE_DATA_START = "2026-07";

/**
 * Customer Care and Telesales, February–June 2026, as supplied by the business.
 *
 * Cash and Wasfaty only, with one exception: a month's total revenue and total
 * orders are *derived* (`cash + wasfaty`) rather than stored, so the totals on
 * screen cannot drift from their parts. Every supplied total is asserted against
 * the derived one in `__tests__/monthly-growth.test.ts`, and seven of the eight
 * months agree exactly. The eighth — June 2026 Telesales — does not, and states
 * its total explicitly; see the note there.
 *
 * Telesales starts in April 2026 — February and March have no Telesales rows at
 * all, deliberately, rather than rows of zeroes.
 */
export const HISTORICAL_MONTHLY: readonly MonthlyTeamEntry[] = [
  {
    month: "2026-02",
    team: "customer_care",
    source: "historical",
    totals: {
      cashRevenue: 21215.45,
      cashOrders: 105,
      wasfatyRevenue: 92587.76,
      wasfatyOrders: 182,
    },
  },
  {
    month: "2026-03",
    team: "customer_care",
    source: "historical",
    totals: { cashRevenue: 29731.05, cashOrders: 161, wasfatyRevenue: 85989.8, wasfatyOrders: 203 },
  },
  {
    month: "2026-04",
    team: "customer_care",
    source: "historical",
    totals: { cashRevenue: 48298.61, cashOrders: 300, wasfatyRevenue: 90470.2, wasfatyOrders: 196 },
  },
  {
    month: "2026-05",
    team: "customer_care",
    source: "historical",
    totals: {
      cashRevenue: 102747.61,
      cashOrders: 564,
      wasfatyRevenue: 113692.89,
      wasfatyOrders: 313,
    },
  },
  {
    month: "2026-06",
    team: "customer_care",
    source: "historical",
    totals: {
      cashRevenue: 121923.8,
      cashOrders: 624,
      wasfatyRevenue: 134423.73,
      wasfatyOrders: 456,
    },
  },
  {
    month: "2026-04",
    team: "telesales",
    source: "historical",
    totals: { cashRevenue: 51217.27, cashOrders: 85, wasfatyRevenue: 630.29, wasfatyOrders: 2 },
  },
  {
    month: "2026-05",
    team: "telesales",
    source: "historical",
    totals: {
      cashRevenue: 75024.43,
      cashOrders: 105,
      wasfatyRevenue: 26090.24,
      wasfatyOrders: 185,
    },
  },
  {
    month: "2026-06",
    team: "telesales",
    source: "historical",
    // The one supplied month whose channels do not add up to its stated total:
    // 56,748.31 + 107,474.89 = 164,223.20 against 188,985.39. See the note on
    // `MonthTeamTotals.totalRevenue` — the stated total is authoritative, and
    // the 24,762.19 difference shows as unallocated rather than disappearing.
    totals: {
      cashRevenue: 56748.31,
      cashOrders: 84,
      wasfatyRevenue: 107474.89,
      wasfatyOrders: 512,
      totalRevenue: 188985.39,
      totalOrders: 596,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Month arithmetic                                                            */
/* -------------------------------------------------------------------------- */

/** `Date` → `yyyy-MM`. */
export function monthKey(date: Date): string {
  return format(date, "yyyy-MM");
}

/** `yyyy-MM` → the first and last calendar day, as the RPCs' `yyyy-MM-dd`. */
export function monthWindow(month: string): { from: string; to: string } {
  const start = parse(month, "yyyy-MM", new Date());
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { from: format(start, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd") };
}

/** `yyyy-MM` → `MMM yyyy`. */
export function monthLabel(month: string): string {
  return format(parse(month, "yyyy-MM", new Date()), "MMM yyyy");
}

/**
 * Every month from `start` to `end` inclusive, in order.
 *
 * This is what makes the section self-extending: the live window is always
 * `LIVE_DATA_START … current month`, so September appears in September without
 * anyone adding a line of code.
 */
export function monthsBetween(start: string, end: string): string[] {
  if (end < start) return [];
  const out: string[] = [];
  let cursor = parse(start, "yyyy-MM", new Date());
  const last = parse(end, "yyyy-MM", new Date());
  while (cursor <= last) {
    out.push(format(cursor, "yyyy-MM"));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Month-over-month change, in percent.
 *
 * `null` — not 0 — when there is nothing to compare against: no previous month,
 * or a previous month of zero, which has no percentage change from it at all.
 * The UI renders that as an em dash rather than as flat growth.
 */
export function growthPct(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** A per-unit average, or `null` when there are no units. */
function ratio(value: number, count: number): number | null {
  return count > 0 ? value / count : null;
}

/** Fill in the totals a month did not state explicitly: cash + wasfaty. */
function resolve(totals: MonthTeamTotals): ResolvedTotals {
  return {
    ...totals,
    totalRevenue: totals.totalRevenue ?? totals.cashRevenue + totals.wasfatyRevenue,
    totalOrders: totals.totalOrders ?? totals.cashOrders + totals.wasfatyOrders,
  };
}

const sumTotals = (a: ResolvedTotals, b: ResolvedTotals): ResolvedTotals => ({
  cashRevenue: a.cashRevenue + b.cashRevenue,
  cashOrders: a.cashOrders + b.cashOrders,
  wasfatyRevenue: a.wasfatyRevenue + b.wasfatyRevenue,
  wasfatyOrders: a.wasfatyOrders + b.wasfatyOrders,
  totalRevenue: a.totalRevenue + b.totalRevenue,
  totalOrders: a.totalOrders + b.totalOrders,
});

const ZERO: ResolvedTotals = {
  cashRevenue: 0,
  cashOrders: 0,
  wasfatyRevenue: 0,
  wasfatyOrders: 0,
  totalRevenue: 0,
  totalOrders: 0,
};

function deriveMetrics(
  totals: ResolvedTotals,
  previous: ResolvedTotals | null,
  source: GrowthSource,
): TeamMonthMetrics {
  const { totalRevenue, totalOrders } = totals;

  return {
    ...totals,
    unallocatedRevenue: totalRevenue - totals.cashRevenue - totals.wasfatyRevenue,
    unallocatedOrders: totalOrders - totals.cashOrders - totals.wasfatyOrders,
    avgOrderValue: ratio(totalRevenue, totalOrders),
    avgCashOrderValue: ratio(totals.cashRevenue, totals.cashOrders),
    avgWasfatyOrderValue: ratio(totals.wasfatyRevenue, totals.wasfatyOrders),
    revenueGrowth: growthPct(totalRevenue, previous?.totalRevenue ?? null),
    orderGrowth: growthPct(totalOrders, previous?.totalOrders ?? null),
    cashRevenueGrowth: growthPct(totals.cashRevenue, previous?.cashRevenue ?? null),
    cashOrderGrowth: growthPct(totals.cashOrders, previous?.cashOrders ?? null),
    wasfatyRevenueGrowth: growthPct(totals.wasfatyRevenue, previous?.wasfatyRevenue ?? null),
    wasfatyOrderGrowth: growthPct(totals.wasfatyOrders, previous?.wasfatyOrders ?? null),
    source,
  };
}

/**
 * The whole timeline: one row per month, each carrying Customer Care, Telesales
 * and their combined figures with every growth rate already derived.
 *
 * A team's growth is measured against the previous month **that team has data
 * for**, so Telesales' first month (April 2026) has no growth rate at all rather
 * than an infinite one off a February that never existed.
 *
 * `currentMonth` marks the month still in progress; nothing is excluded for it,
 * but the row is flagged so the UI can say the figures are partial and so
 * `buildInsights` can decline to draw conclusions from half a month.
 */
export function buildMonthlyGrowth(
  entries: readonly MonthlyTeamEntry[],
  options: { currentMonth?: string } = {},
): MonthRow[] {
  // Live wins over historical for the same team-month: the baseline is only
  // there for the window the orders table cannot answer for.
  const byKey = new Map<string, MonthlyTeamEntry>();
  for (const entry of entries) {
    const key = `${entry.month}|${entry.team}`;
    const existing = byKey.get(key);
    if (!existing || entry.source === "live") byKey.set(key, entry);
  }

  const months = Array.from(new Set(Array.from(byKey.values(), (e) => e.month))).sort();

  const previousByTeam = new Map<GrowthTeam, ResolvedTotals>();
  let previousCombined: ResolvedTotals | null = null;

  return months.map((month) => {
    const perTeam = {} as Record<GrowthTeam, TeamMonthMetrics | null>;
    let combinedTotals = ZERO;
    const sources = new Set<GrowthSource>();

    for (const team of GROWTH_TEAMS) {
      const entry = byKey.get(`${month}|${team}`);
      if (!entry) {
        perTeam[team] = null;
        continue;
      }
      const totals = resolve(entry.totals);
      perTeam[team] = deriveMetrics(totals, previousByTeam.get(team) ?? null, entry.source);
      previousByTeam.set(team, totals);
      combinedTotals = sumTotals(combinedTotals, totals);
      sources.add(entry.source);
    }

    const combinedSource: GrowthSource = sources.size === 1 ? [...sources][0]! : "mixed";
    const combined = deriveMetrics(combinedTotals, previousCombined, combinedSource);
    previousCombined = combinedTotals;

    return {
      month,
      label: monthLabel(month),
      customerCare: perTeam.customer_care,
      telesales: perTeam.telesales,
      combined,
      partial: month === options.currentMonth,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Insights                                                                    */
/* -------------------------------------------------------------------------- */

export type InsightTone = "positive" | "negative" | "neutral";

export interface Insight {
  id: string;
  text: string;
  tone: InsightTone;
}

const pct = (n: number) => `${Math.abs(n).toFixed(2)}%`;
const moved = (n: number) => (n >= 0 ? "increased" : "decreased");

/**
 * Plain-language readings of the numbers above them — computed, never written.
 *
 * Every line is emitted only when the calculation behind it exists: a team with
 * no previous month contributes no growth sentence, and a month with no orders
 * contributes no average-order-value sentence. There is no template that fires
 * on missing data, and no model involved.
 *
 * The subject is the last **complete** month. A month that is still running is
 * being compared against a full one, and "revenue fell 74%" on the 8th is not an
 * insight, it is an artefact of the calendar.
 */
export function buildInsights(rows: readonly MonthRow[]): Insight[] {
  const complete = rows.filter((r) => !r.partial);
  const current = complete[complete.length - 1];
  if (!current) return [];
  const previous = complete[complete.length - 2] ?? null;

  const insights: Insight[] = [];
  const teams = [
    { key: "customerCare" as const, name: "Customer Care" },
    { key: "telesales" as const, name: "Telesales" },
  ];

  for (const { key, name } of teams) {
    const metrics = current[key];
    if (!metrics || metrics.revenueGrowth == null) continue;
    insights.push({
      id: `${key}-revenue-growth`,
      text: `${name} revenue ${moved(metrics.revenueGrowth)} ${pct(metrics.revenueGrowth)} in ${current.label}.`,
      tone: metrics.revenueGrowth >= 0 ? "positive" : "negative",
    });
  }

  // Which payment channel the month actually rests on.
  if (current.combined.totalRevenue > 0) {
    const share = (current.combined.wasfatyRevenue / current.combined.totalRevenue) * 100;
    insights.push({
      id: "wasfaty-share",
      text: `Wasfaty contributed ${share.toFixed(1)}% of total revenue in ${current.label}, Cash ${(100 - share).toFixed(1)}%.`,
      tone: "neutral",
    });
  }

  const combined = current.combined;
  const previousAov = previous?.combined.avgOrderValue ?? null;

  // Volume against basket size — the two ways revenue can move, and the reason
  // the section carries average order value at all.
  if (combined.orderGrowth != null && combined.avgOrderValue != null && previousAov != null) {
    const aovGrowth = growthPct(combined.avgOrderValue, previousAov);
    if (aovGrowth != null) {
      if (combined.orderGrowth > 0 && aovGrowth < 0) {
        insights.push({
          id: "volume-vs-aov",
          text: `In ${current.label} order volume increased ${pct(combined.orderGrowth)} while average order value decreased ${pct(aovGrowth)}.`,
          tone: "neutral",
        });
      } else if (combined.orderGrowth < 0 && aovGrowth > 0) {
        insights.push({
          id: "volume-vs-aov",
          text: `In ${current.label} order volume decreased ${pct(combined.orderGrowth)} while average order value increased ${pct(aovGrowth)}.`,
          tone: "neutral",
        });
      }

      if (combined.revenueGrowth != null && combined.revenueGrowth !== 0) {
        const driver =
          Math.abs(combined.orderGrowth) >= Math.abs(aovGrowth)
            ? "order volume"
            : "higher average order value";
        insights.push({
          id: "growth-driver",
          text: `Combined revenue ${moved(combined.revenueGrowth)} ${pct(combined.revenueGrowth)} in ${current.label}, driven primarily by ${driver}.`,
          tone: combined.revenueGrowth >= 0 ? "positive" : "negative",
        });
      }
    }
  }

  // Which team carried the month.
  if (current.customerCare && current.telesales && combined.totalRevenue > 0) {
    const careShare = (current.customerCare.totalRevenue / combined.totalRevenue) * 100;
    const leader = careShare >= 50 ? "Customer Care" : "Telesales";
    const leaderShare = careShare >= 50 ? careShare : 100 - careShare;
    insights.push({
      id: "team-share",
      text: `${leader} generated ${leaderShare.toFixed(1)}% of ${current.label} revenue.`,
      tone: "neutral",
    });
  }

  return insights;
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                             */
/* -------------------------------------------------------------------------- */

/** A growth rate as text: `+55.97%`, `-3.10%`, or an em dash when there is none. */
export function formatGrowth(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}
