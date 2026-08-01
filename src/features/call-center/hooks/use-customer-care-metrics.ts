/**
 * The Customer Care dashboard's single data entry point.
 *
 * Three queries in, one `CustomerCareMetrics` out:
 *
 *   CDR analytics  → every historical KPI          (`getCallCenterAnalytics`)
 *   Call Report    → per-agent missed calls only   (`yeastarCallReport`, v2.0)
 *   Queue status   → the realtime tiles            (`yeastarRealtimeQueue`)
 *
 * The route renders `metrics.*` and nothing else. It does not read the raw
 * query payloads, and it does not compute — see the contract on
 * `buildCustomerCareMetrics`.
 *
 * Failure behaviour is deliberately asymmetric, because the sources are not
 * equally important. A CDR failure is a page failure. A Call Report or realtime
 * failure degrades one region of the page and is reported through
 * `metrics.callReport` / `metrics.realtime.available`, never by throwing — the
 * KPIs that already match Yeastar are CDR-derived and must keep rendering.
 */
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCallCenterAnalytics, yeastarCallReport } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import { buildCustomerCareMetrics, type CustomerCareMetrics } from "@/lib/yeastar/metrics-engine";
import { useRealtimeQueue } from "./use-realtime-queue";
import type { Direction } from "../types";

interface UseCustomerCareMetricsArgs {
  from: string;
  to: string;
  agentId: string;
  direction: Direction;
  /** Queue number, or "all". */
  queue: string;
  canAll: boolean;
  canView: boolean;
  authLoading: boolean;
  search: string;
  /** Background refresh cadence in ms. */
  refreshMs: number;
}

export interface UseCustomerCareMetricsResult {
  metrics: CustomerCareMetrics;
  /** True only when there is genuinely nothing to show yet. */
  isLoading: boolean;
  /** A background refresh is in flight while data is already on screen. */
  isRefreshing: boolean;
  /** A refresh failed but the last good analytics are still displayed. */
  refreshFailed: boolean;
  errMsg: string | null;
  /** True when the CDR analytics query has usable data. */
  ok: boolean;
  /** The realtime tiles have never resolved yet — for their own skeletons. */
  realtimeLoading: boolean;
  refresh: () => void;
}

export function useCustomerCareMetrics({
  from,
  to,
  agentId,
  direction,
  queue,
  canAll,
  canView,
  authLoading,
  search,
  refreshMs,
}: UseCustomerCareMetricsArgs): UseCustomerCareMetricsResult {
  const analyticsFn = useServerFn(getCallCenterAnalytics);
  const callReportFn = useServerFn(yeastarCallReport);
  const realtimeQuery = useRealtimeQueue({ authLoading, canView });

  const analyticsQuery = useQuery({
    queryKey: queryKeys.callCenter.analytics({
      from,
      to,
      team: "customer_care",
      agentId,
      direction,
      queue,
    }),
    queryFn: () =>
      analyticsFn({
        data: {
          from,
          to,
          team: "customer_care" as const,
          agentId: canAll && agentId !== "all" ? agentId : null,
          direction,
          status: "all" as const,
          ...(queue && queue !== "all" ? { queue } : {}),
          includeOrders: false,
        },
      }),
    enabled: !authLoading && canView,
    staleTime: refreshMs,
    placeholderData: keepPreviousData,
    refetchInterval: refreshMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
    refetchOnReconnect: true,
  });

  // Deliberately a SEPARATE query, not folded into the analytics server fn.
  // Call Report is queue-scoped and inbound by construction, so its response is
  // identical across the direction and agent filters — giving it its own key
  // means toggling those filters re-renders from cache instead of re-querying
  // the PBX. It also keeps a Call Report outage off the analytics path.
  const callReportQuery = useQuery({
    queryKey: queryKeys.callCenter.callReport({ from, to, queue }),
    queryFn: () =>
      callReportFn({ data: { from, to, ...(queue && queue !== "all" ? { queue } : {}) } }),
    enabled: !authLoading && canView,
    staleTime: refreshMs,
    placeholderData: keepPreviousData,
    refetchInterval: refreshMs,
    refetchIntervalInBackground: false,
    // A missing missed-calls column must never surface as a page error, so this
    // query fails quietly and the engine reports it as an unavailable source.
    retry: 1,
    throwOnError: false,
  });

  const data = analyticsQuery.data;
  const ok = !!data && data.ok === true;
  const configured = !data || (data as { configured?: boolean }).configured !== false;

  const isLoading = authLoading || (!data && analyticsQuery.isPending);
  const isRefreshing = !!data && analyticsQuery.isFetching;
  const refreshFailed = !!data && !!analyticsQuery.error;

  const errored = (data && data.ok === false) || (!data && !!analyticsQuery.error);
  const errMsg =
    !data && analyticsQuery.error instanceof Error
      ? analyticsQuery.error.message
      : errored
        ? configured
          ? "Call analytics are temporarily unavailable."
          : "Call analytics are not configured yet."
        : null;

  const metrics = useMemo(
    () =>
      buildCustomerCareMetrics({
        analytics: ok
          ? {
              totals: data.totals,
              agents: data.agents,
              byDay: data.byDay,
              byHour: data.byHour,
            }
          : null,
        // An errored Call Report query yields no snapshot at all, which the
        // engine reports as `attempted: false` rather than inventing zeros.
        callReport: callReportQuery.data ?? null,
        realtime: realtimeQuery.data ?? null,
        filters: { direction, queue, agentId, search },
      }),
    [ok, data, callReportQuery.data, realtimeQuery.data, direction, queue, agentId, search],
  );

  return {
    metrics,
    isLoading,
    isRefreshing,
    refreshFailed,
    errMsg,
    ok,
    realtimeLoading: realtimeQuery.isPending,
    refresh: () => {
      void analyticsQuery.refetch();
      void callReportQuery.refetch();
      void realtimeQuery.refetch();
    },
  };
}
