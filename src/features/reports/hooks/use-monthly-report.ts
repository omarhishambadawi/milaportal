import { useMemo } from "react";
import { useCallReportQuery } from "@/features/call-center/hooks/use-call-report";
import { resolveRefreshPolicy } from "@/features/call-center/refresh-policy";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";
import type { DashboardSection } from "@/features/dashboard/hooks/use-dashboard-data";
import {
  buildCallCenterBreakdown,
  buildCallSummary,
  buildExecutiveSummary,
  buildOrderTypeSplit,
  buildTeamPerformance,
  summarizeTrend,
  type OrderBuckets,
} from "../monthly";
import { useReportCalls } from "./use-report-calls";
import { useReportOrderKpis } from "./use-report-orders";

/**
 * The five Dashboard aggregations this report actually reads.
 *
 * It used to take `useDashboardData` wholesale, which meant eleven RPCs per
 * month for five that get rendered: the agent ranking, the delivery crosstab,
 * invoice verification and both complaints aggregations were fetched, parsed and
 * discarded on every visit. Naming the five keeps the reuse — same hook, same
 * keys, same derivations, still a cache hit against a Dashboard that has seen
 * the month — and stops paying for the six.
 */
const REPORT_SECTIONS: readonly DashboardSection[] = [
  "kpis",
  "daily",
  "status",
  "locations",
  "delivery",
];

/** Top-N for the ranked charts, past which a bar chart stops being readable. */
const TOP_N = 10;

/**
 * The monthly report's data.
 *
 * `useDashboardData` is reused rather than reimplemented, and that is the
 * load-bearing decision in this file. It already fetches, for one window and
 * under `queryKeys.dashboard.*`, every aggregation this report needs: the KPI
 * buckets, the daily trend, the status split, the locations and the delivery
 * methods. Asking it for the month means the report and the dashboard cannot
 * disagree, because they are literally reading the same cache entries. What
 * changed is only *how much* of it is asked for — see `REPORT_SECTIONS`.
 *
 * Two extra `orders_kpis` calls sit on top, one per team, because the team
 * comparison needs Cash and Wasfaty per team and `orders_teams` carries only
 * sales and a completion rate. Same RPC, same key namespace, shared cache.
 */
export function useMonthlyReport(args: {
  from: string;
  to: string;
  canView: boolean;
  authLoading: boolean;
  viewerId?: string;
  /** False while the Daily tab is the one on screen. See `useDailyReport`. */
  active?: boolean;
}) {
  const { from, to, canView, authLoading, active = true } = args;
  const wanted = canView && active;
  const enabled = wanted && !authLoading;

  // `DashboardFilters` exactly, so these are the Dashboard's own cache entries.
  const dashFilters = { from, to, agent: "all", team: "all" };

  const dashboard = useDashboardData({
    from,
    to,
    effectiveTeam: "all",
    effectiveAgent: "all",
    dashFilters,
    cmpFilters: { from, to, agent: "all" },
    enabled,
    sections: REPORT_SECTIONS,
    viewerId: args.viewerId,
    // A management report names its teams; nothing here renders an agent
    // ranking, so there is no identity to restrict.
    restrictAgentIdentity: false,
  });

  const careOrders = useReportOrderKpis({ from, to, team: "customer_care", enabled });
  const telesalesOrders = useReportOrderKpis({ from, to, team: "telesales", enabled });

  // Whole-network telephony for the month: both directions, both teams. Its
  // `teamCompare` carries the per-team volumes, so Customer Care and Telesales
  // call counts cost no additional query.
  const calls = useReportCalls({ from, to, team: "all", canView: wanted, authLoading });

  /**
   * Telesales only, with the orders join — the one query the conversion rate
   * needs and the only reason it is asked for separately.
   *
   * Identical arguments to the Telesales Calls page, so it shares that page's
   * cache entry rather than opening a second, differently-scoped view of the
   * same month.
   */
  const telesalesCalls = useReportCalls({
    from,
    to,
    team: "telesales",
    canView: wanted,
    authLoading,
    includeOrders: true,
  });

  /**
   * Yeastar's own queue report, for the Missed / Abandoned split only.
   *
   * The same query the Calls pages run, under the same key, so this is a cache
   * hit whenever one of them has already looked at the month. Its absence is not
   * an error — `buildCallSummary` falls back to CDR's split and reports which it
   * used.
   */
  const callReport = useCallReportQuery({
    from,
    to,
    queue: "all",
    enabled,
    policy: resolveRefreshPolicy(from, to, 60_000, new Date().toISOString().slice(0, 10)),
  });

  /**
   * The month's buckets, straight off the Dashboard's own KPI derivation.
   *
   * `DashKpiStats` is a structural superset of `BucketStats` — it also carries
   * pending and cancelled counts, which no section of this report reads — so it
   * assigns without a cast or a mapping step.
   */
  const overall: OrderBuckets = useMemo(
    () => ({
      cash: dashboard.kpiByBucket.cash,
      wasfaty: dashboard.kpiByBucket.wasfaty,
      total: dashboard.kpiByBucket.total,
    }),
    [dashboard.kpiByBucket],
  );

  const summary = useMemo(() => buildExecutiveSummary(overall), [overall]);

  const teams = useMemo(
    () => buildTeamPerformance(careOrders.buckets, telesalesOrders.buckets, overall),
    [careOrders.buckets, telesalesOrders.buckets, overall],
  );

  const orderTypes = useMemo(() => buildOrderTypeSplit(overall), [overall]);

  const trend = useMemo(
    () =>
      dashboard.dailyData.map((point) => ({
        date: point.date,
        total: point.total,
        completed: point.completed,
      })),
    [dashboard.dailyData],
  );

  const trendHighlights = useMemo(() => summarizeTrend(trend), [trend]);

  const callSummary = useMemo(() => {
    const totals = calls.totals;
    return buildCallSummary(
      {
        total: totals?.total ?? 0,
        inbound: totals?.inbound ?? 0,
        answered: totals?.answered ?? 0,
        missed: totals?.missed ?? 0,
        abandoned: totals?.abandoned ?? 0,
        talkSeconds: totals?.talkSeconds ?? 0,
      },
      callReport.data?.queue ?? null,
      calls.ok ? "cdr" : "unavailable",
    );
  }, [calls.totals, calls.ok, callReport.data]);

  /**
   * Per-team volumes and the Telesales conversion rate.
   *
   * Both come from the Calls module's own analytics — `teamCompare` for the
   * split, `conversion.overall.conversionRate` for the rate — so the report
   * neither reclassifies an extension nor recomputes orders ÷ answered.
   */
  const callCenter = useMemo(
    () =>
      buildCallCenterBreakdown(
        calls.teamCompare,
        calls.totals?.total ?? 0,
        telesalesCalls.conv?.overall.conversionRate ?? null,
      ),
    [calls.teamCompare, calls.totals, telesalesCalls.conv],
  );

  /* ---------------------------------------------------------------------- */
  /* Chart series                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Revenue by team, off the same rows the table above the chart renders.
   *
   * Not `orders_teams` — that RPC would be a sixth request answering a question
   * the two per-team `orders_kpis` calls already answered, and two sources for
   * "Telesales revenue" on one page is exactly what this module exists to avoid.
   */
  const teamRevenue = useMemo(
    () =>
      [...teams.rows, teams.total].map((row) => ({
        name: row.team,
        total: row.totalSales,
        completed: row.completedSales,
      })),
    [teams],
  );

  /**
   * The ranked slices the charts render.
   *
   * Capped, because a bar chart of forty cities is a wall of hairlines. The full
   * lists stay on `cities` / `branches` for the tables and the workbook, which
   * are read rather than glanced at and do not have the same limit.
   */
  const topCities = useMemo(() => dashboard.cityData.slice(0, TOP_N), [dashboard.cityData]);
  const topBranches = useMemo(() => dashboard.branchData.slice(0, TOP_N), [dashboard.branchData]);

  /** Completed revenue per delivery company, ranked. */
  const deliveryRevenue = useMemo(
    () =>
      dashboard.deliveryData
        .map((row) => ({ name: row.name, sales: row.sales }))
        .sort((a, b) => b.sales - a.sales),
    [dashboard.deliveryData],
  );

  /** Cash against Wasfaty, on completed revenue — the split's own rows. */
  const orderTypeRevenue = useMemo(
    () => orderTypes.rows.map((row) => ({ name: row.label, sales: row.sales })),
    [orderTypes],
  );

  /** The month's best-selling city, for the KPI strip. Null for a quiet month. */
  const topCity = useMemo(() => dashboard.cityData[0] ?? null, [dashboard.cityData]);

  return {
    summary,
    teams,
    orderTypes,
    fulfillment: dashboard.fulfillmentMix,
    trend,
    trendHighlights,
    calls: callSummary,
    callCenter,
    callsUnavailable: !calls.ok,
    cities: dashboard.cityData,
    branches: dashboard.branchData,
    topCity,
    // Chart series, memoised so Recharts is not handed a new array per render.
    topCities,
    topBranches,
    teamRevenue,
    statusData: dashboard.statusData,
    deliveryRevenue,
    orderTypeRevenue,
    isLoading: careOrders.isLoading || telesalesOrders.isLoading,
  };
}
