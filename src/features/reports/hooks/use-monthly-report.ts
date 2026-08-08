import { useMemo } from "react";
import { useCallReportQuery } from "@/features/call-center/hooks/use-call-report";
import { resolveRefreshPolicy } from "@/features/call-center/refresh-policy";
import { useDashboardData } from "@/features/dashboard/hooks/use-dashboard-data";
import {
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
 * The monthly report's data.
 *
 * `useDashboardData` is reused wholesale rather than reimplemented, and that is
 * the load-bearing decision in this file. It already fetches, for one window and
 * under `queryKeys.dashboard.*`, every aggregation this report needs: the KPI
 * buckets, the daily trend, the locations, the delivery methods and — since the
 * fulfillment work — the delivery-vs-pickup mix. Asking it for the month means
 * the report and the dashboard cannot disagree, because they are literally
 * reading the same cache entries.
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
}) {
  const { from, to, canView, authLoading } = args;
  const enabled = canView && !authLoading;

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
    viewerId: args.viewerId,
    // A management report names its teams; nothing here renders an agent
    // ranking, so there is no identity to restrict.
    restrictAgentIdentity: false,
  });

  const careOrders = useReportOrderKpis({ from, to, team: "customer_care", enabled });
  const telesalesOrders = useReportOrderKpis({ from, to, team: "telesales", enabled });

  // Whole-network telephony for the month: both directions, both teams.
  const calls = useReportCalls({ from, to, team: "all", canView, authLoading });

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

  return {
    summary,
    teams,
    orderTypes,
    fulfillment: dashboard.fulfillmentMix,
    trend,
    trendHighlights,
    calls: callSummary,
    callsUnavailable: !calls.ok,
    cities: dashboard.cityData,
    branches: dashboard.branchData,
    isLoading: careOrders.isLoading || telesalesOrders.isLoading,
  };
}
