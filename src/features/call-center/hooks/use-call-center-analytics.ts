import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCallCenterAnalytics } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import type { Team, Direction } from "../types";
import { hourLabel } from "../utils";

interface UseCallCenterAnalyticsArgs {
  from: string;
  to: string;
  team: Team;
  agentId: string;
  direction: Direction;
  /** Customer Care only. "all" (or omitted) means every queue. */
  queue?: string;
  canAll: boolean;
  canView: boolean;
  authLoading: boolean;
  search: string;
  /**
   * Background refresh cadence in ms. Customer Care watches a live queue and
   * wants ~20s; Telesales reviews a day's outbound work and 60s is plenty.
   */
  refreshMs: number;
}

/**
 * The single analytics query behind both dashboards, plus every derived slice.
 *
 * Stale-while-revalidate, deliberately:
 *
 *   - `placeholderData: keepPreviousData` keeps the previous window's numbers
 *     on screen while a new one loads, so a filter change never blanks the page.
 *   - React Query only swaps `data` on a SUCCESSFUL response, so a failed
 *     refresh leaves the last good analytics visible and merely raises `isError`
 *     — surfaced as a small non-blocking warning rather than an empty page.
 *   - `isLoading` is true only when there is genuinely nothing to show. Every
 *     other fetch is a background refresh and reports through `isRefreshing`.
 *
 * There is deliberately NO progress polling. The previous version polled a
 * progress endpoint every 800ms during any fetch — a `getSession()` call, an
 * HTTP request and a full re-render three times over per two seconds, which
 * rebuilt every chart's data array and made Recharts replay its enter
 * animation. That is what made the dashboards appear to load, clear and reload
 * on a loop. A CDR sweep has no measurable progress to report anyway, so the
 * bar was inventing precision it never had.
 */
export function useCallCenterAnalytics({
  from,
  to,
  team,
  agentId,
  direction,
  queue = "all",
  canAll,
  canView,
  authLoading,
  search,
  refreshMs,
}: UseCallCenterAnalyticsArgs) {
  const analyticsFn = useServerFn(getCallCenterAnalytics);
  const q = useQuery({
    queryKey: queryKeys.callCenter.analytics({ from, to, team, agentId, direction, queue }),
    queryFn: () =>
      analyticsFn({
        data: {
          from,
          to,
          team,
          agentId: canAll && agentId !== "all" ? agentId : null,
          direction,
          status: "all",
          // Omitted entirely when no queue is selected, so the request is
          // byte-identical to what it was before the queue filter existed.
          ...(queue && queue !== "all" ? { queue } : {}),
          includeOrders: true,
        },
      }),
    enabled: !authLoading && canView,
    // The window's data is considered fresh until the next scheduled refresh,
    // so a remount inside that window reuses the cache instead of refetching.
    staleTime: refreshMs,
    placeholderData: keepPreviousData,
    refetchInterval: refreshMs,
    // Hidden tabs are not watching, so polling them is pure cost. Coming back
    // to the tab triggers one refresh, which is the moment it actually matters.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
    refetchOnReconnect: true,
  });

  const data = q.data;
  const ok = data && data.ok === true;
  const configured = !data || (data as any).configured !== false;

  // Skeletons are for having nothing to show. Any fetch with data already on
  // screen is a background refresh and must not clear the page.
  const isLoading = authLoading || (!data && q.isPending);
  const isRefreshing = !!data && q.isFetching;
  /** A refresh failed but the last good analytics are still displayed. */
  const refreshFailed = !!data && !!q.error;

  const errored = (data && data.ok === false) || (!data && !!q.error);
  const errMsg =
    !data && q.error instanceof Error
      ? q.error.message
      : errored
        ? configured
          ? "Call analytics are temporarily unavailable."
          : "Call analytics are not configured yet."
        : null;

  const totals = ok ? data.totals : null;
  const rows = useMemo(() => (ok ? data.agents : []), [ok, data]);
  const byDay = useMemo(() => (ok ? data.byDay : []), [ok, data]);
  const byHour = useMemo(() => (ok ? data.byHour : []), [ok, data]);
  const teamCompare = useMemo(() => (ok ? data.teamCompare : []), [ok, data]);
  const conv = ok ? data.conversion : null;

  // Memoised so the array identity only changes when the data does. Recharts
  // re-runs its enter animation whenever its `data` prop is a new reference, so
  // rebuilding these per render is what made charts visibly redraw.
  const hourly12 = useMemo(() => byHour.map((h) => ({ ...h, label: hourLabel(h.hour) })), [byHour]);

  const searchedAgents = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.ext.toLowerCase().includes(s));
  }, [rows, search]);

  return {
    q,
    ok,
    isLoading,
    isRefreshing,
    refreshFailed,
    errMsg,
    totals,
    rows,
    byDay,
    byHour,
    teamCompare,
    conv,
    hourly12,
    searchedAgents,
    refresh: q.refetch,
  };
}
